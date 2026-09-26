# platform/autoupgrade — weekly flake-native upgrade.
#
# Advances flake.lock within the pinned branches (only
# `fleet.autoupgrade.inputs`), builds it, and only then commits the lock,
# stages the new generation for next boot and pushes. Never auto-reboots
# (you reboot manually) and never touches the running system. Every
# upgrade is a git commit — inspectable, revertible.
#
# The GitHub SSH identity is owned by platform/git (fleet.git.sshKeySopsFile →
# /run/secrets/github-ssh-key); the push below consumes it via the
# sops option reference.

{
  config,
  lib,
  pkgs,
  ...
}:

let
  # Script body lives at assets/autoupgrade.sh (pure Bash, shellcheckable
  # standalone). This wrapper sets the parameters it expects as env vars,
  # then concatenates the body so writeShellApplication runs it all in one
  # shell with shellcheck across the whole. Same shape as
  # cloudflared-route-sync (modules/cloudflared).
  #
  # runtimeInputs is what lets the body call `git`/`ssh`/`setpriv`/`flock` by
  # name instead of interpolating store paths into it, which keeps it
  # readable and lintable.
  upgradeScript = pkgs.writeShellApplication {
    name = "flake-autoupgrade";
    runtimeInputs = [
      pkgs.git
      pkgs.openssh
      pkgs.util-linux
      pkgs.coreutils
    ];
    text = ''
      REBUILD_LOCK=${lib.escapeShellArg config.fleet.rebuildLock}
      GITHUB_SSH_KEY=${lib.escapeShellArg config.sops.secrets."github-ssh-key".path}
      FLAKE=${lib.escapeShellArg config.fleet.config.repo}
      HOSTNAME=${lib.escapeShellArg config.networking.hostName}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      OPERATOR_HOME=${lib.escapeShellArg config.fleet.operator.home}
      UPGRADE_INPUTS=${lib.escapeShellArg (lib.concatStringsSep " " config.fleet.autoupgrade.inputs)}

      ${builtins.readFile ./assets/autoupgrade.sh}
    '';
  };
in

{
  # The one lock every rebuild takes.
  #
  # Declared here because this module is the OTHER rebuilder: a weekly
  # `nix flake update` + build + commit + `nixos-rebuild boot` + push, any of
  # which can collide with daedalus applying a registry change — both building,
  # both committing to the same repo, both pushing. Overlapping activations and
  # interleaved commits are how the running system ends up matching neither
  # branch.
  #
  # Anything that rebuilds or commits to the configuration checkout should
  # take it, including a human:
  #   flock /run/lock/fleet-rebuild.lock sudo nixos-rebuild switch
  # That cannot be enforced on an interactive shell — a lock nobody is obliged
  # to take is advisory by nature — but every automated path takes it (this
  # job, and daedalus's apply, updaters and power verbs), and those are the
  # ones that fire unattended.
  options.fleet.autoupgrade.inputs = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    example = [
      "nixpkgs"
      "sops-nix"
    ];
    description = ''
      The flake inputs the weekly upgrade moves. Empty means all of them.

      Name them on a box whose flake pins the ENGINE as an input: that one
      should move only when someone decides it should. A local-clone input
      follows whatever is committed in the clone, and an unattended job is
      the wrong thing to find out what that was.
    '';
  };

  options.fleet.rebuildLock = lib.mkOption {
    type = lib.types.str;
    default = "/run/lock/fleet-rebuild.lock";
    readOnly = true;
    description = ''
      flock path serialising everything that rebuilds this system or commits to
      the configuration checkout (`fleet.config.repo`). On tmpfs, so a reboot cannot leave a stale lock behind; the
      lock releases when the holder's fd closes, including on a crash.
    '';
  };

  # Dead-man's-switch ping (platform/hc-ping): weekly.
  config.fleet.monitoredJobs.flake-autoupgrade.slug = "flake-autoupgrade";

  config.systemd.services.flake-autoupgrade = {
    description = "Update flake.lock, commit, stage next-boot generation, push";
    # Persistent=true replays a missed window right at boot, where the
    # flake update needs GitHub over DNS that resolves through the
    # local pi-hole — gate on both (same accepted platform->stacks
    # layering inversion as ddclient).
    after = [
      "network-online.target"
      "pihole-ready.service"
    ];
    wants = [
      "network-online.target"
      "pihole-ready.service"
    ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = lib.getExe upgradeScript;
    };
  };

  config.systemd.timers.flake-autoupgrade = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "weekly";
      Persistent = true; # catch up if the box was off
      RandomizedDelaySec = "45min";
    };
  };
}
