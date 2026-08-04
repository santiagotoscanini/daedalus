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
    serviceConfig.Type = "oneshot";
    # System nix (not pkgs.nix): the running nix honors /etc/gitconfig
    # safe.directory for the santiago-owned repo; a mismatched pkgs.nix
    # trips the libgit2 ownership check and the unit fails.
    path = [ pkgs.git ];
    # The repo is santiago-owned and builds go through the nix daemon,
    # so only `nixos-rebuild boot` needs root: the lock update, commit,
    # and push all run as santiago via setpriv (no PAM session,
    # matching stacks/apps) — .git never grows root-owned objects.
    # Offline must not fail the upgrade: the lock is already committed
    # locally, so a failed push is swallowed and the next run carries
    # it forward.
    script = ''
      cd /etc/nixos
      as_santiago() {
        ${pkgs.util-linux}/bin/setpriv --reuid santiago --regid users --init-groups \
          ${pkgs.coreutils}/bin/env HOME=/home/santiago "$@"
      }

      # Serialise against daedalus's apply (fleet.rebuildLock). Waits rather
      # than failing: this is a weekly unattended job with no one watching, and
      # an apply finishes in minutes. If it somehow cannot get the lock in 30
      # minutes, skip this run entirely — the timer is Persistent and next
      # week's run carries the update forward, which is much better than
      # rebuilding on top of someone else's half-applied change.
      exec 9>${lib.escapeShellArg config.fleet.rebuildLock}
      if ! ${pkgs.util-linux}/bin/flock -w 1800 9; then
        echo "flake-autoupgrade: another rebuild holds ${config.fleet.rebuildLock}; skipping this run"
        exit 0
      fi

      as_santiago /run/current-system/sw/bin/nix flake update --commit-lock-file
      /run/current-system/sw/bin/nixos-rebuild boot --flake /etc/nixos

      as_santiago \
        ${pkgs.coreutils}/bin/env GIT_SSH_COMMAND="${pkgs.openssh}/bin/ssh -i ${
          config.sops.secrets."github-ssh-key".path
        } -o BatchMode=yes -o IdentitiesOnly=yes" \
        ${pkgs.git}/bin/git push origin main \
        || echo "flake-autoupgrade: git push failed (offline?); lock committed locally, retrying next run"
    '';
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
