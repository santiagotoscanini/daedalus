# platform/autoupgrade — weekly flake-native upgrade.
#
# Advances flake.lock within the pinned branches, commits the lock,
# stages the new generation for next boot, pushes. Never auto-reboots
# (you reboot manually) and never touches the running system. Every
# upgrade is a git commit — inspectable, revertible.
#
# The GitHub SSH identity is owned by platform/git (github-key.sops →
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
  # standalone). This wrapper sets the two parameters it expects as env vars,
  # then concatenates the body so writeShellApplication runs it all in one
  # shell with shellcheck across the whole. Same shape as
  # cloudflared-route-sync and the app-db bootstrap.
  #
  # runtimeInputs is what lets the body call `git`/`ssh`/`setpriv`/`flock` by
  # name instead of interpolating store paths into it — which is what made the
  # old inline version unreadable and un-lintable.
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

      ${builtins.readFile ./assets/autoupgrade.sh}
    '';
  };
in

{
  # The one lock every rebuild takes.
  #
  # Declared here because this module is the OTHER rebuilder: a weekly
  # `nix flake update --commit-lock-file` + `nixos-rebuild boot` + push, any of
  # which can collide with daedalus applying a registry change — both building,
  # both committing to the same repo, both pushing. Overlapping activations and
  # interleaved commits are how the running system ends up matching neither
  # branch.
  #
  # Anything that rebuilds or commits to /etc/nixos should take it, including a
  # human:
  #   flock /run/lock/s2-rebuild.lock sudo nixos-rebuild switch
  # That cannot be enforced on an interactive shell — a lock nobody is obliged
  # to take is advisory by nature — but both automated paths respect it, and
  # those are the ones that fire unattended.
  options.fleet.rebuildLock = lib.mkOption {
    type = lib.types.str;
    default = "/run/lock/s2-rebuild.lock";
    readOnly = true;
    description = ''
      flock path serialising everything that rebuilds this system or commits to
      /etc/nixos. On tmpfs, so a reboot cannot leave a stale lock behind; the
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
