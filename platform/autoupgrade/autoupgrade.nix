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
  pkgs,
  ...
}:

{
  # Dead-man's-switch ping (platform/hc-ping): weekly.
  fleet.monitoredJobs.flake-autoupgrade.slug = "flake-autoupgrade";

  systemd.services.flake-autoupgrade = {
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

  systemd.timers.flake-autoupgrade = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "weekly";
      Persistent = true; # catch up if the box was off
      RandomizedDelaySec = "45min";
    };
  };
}
