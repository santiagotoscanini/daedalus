# platform/autoupgrade — weekly flake-native upgrade.
#
# Advances flake.lock within the pinned branches, commits the lock,
# stages the new generation for next boot, pushes. Never auto-reboots
# (you reboot manually) and never touches the running system. Every
# upgrade is a git commit — inspectable, revertible.
#
# The GitHub SSH key is sops-managed: github-key.sops decrypts to
# /run/secrets/github-ssh-key (santiago, 0400); the public half is
# registered at https://github.com/settings/ssh. platform/git.nix
# points interactive `ssh git@github.com` at the same path.

{
  config,
  pkgs,
  ...
}:

{
  sops.secrets."github-ssh-key" = {
    sopsFile = ./github-key.sops;
    format = "binary";
    owner = "santiago";
    mode = "0400";
  };

  # Dead-man's-switch ping (platform/hc-ping): weekly.
  myStack.hcPings."flake-autoupgrade" = "flake-autoupgrade";

  systemd.services.flake-autoupgrade = {
    description = "Update flake.lock, commit, stage next-boot generation, push";
    serviceConfig.Type = "oneshot";
    # System nix (not pkgs.nix): the running nix honors /etc/gitconfig
    # safe.directory for the santiago-owned repo; a mismatched pkgs.nix
    # trips the libgit2 ownership check and the unit fails.
    path = [ pkgs.git ];
    script = ''
      cd /etc/nixos
      /run/current-system/sw/bin/nix flake update --commit-lock-file
      /run/current-system/sw/bin/nixos-rebuild boot --flake /etc/nixos

      # Push the lock-bump commit to origin. The push key is
      # santiago-owned, so drop to santiago with setpriv (no PAM
      # session, matching stacks/apps). The commit above ran as root
      # and wrote root-owned objects into .git; chown back to santiago
      # first so santiago can push now AND hand-commit later without
      # hitting "insufficient permission" on root-owned objects.
      # Offline must not fail the upgrade: the lock is already
      # committed locally, so a failed push is swallowed and the next
      # run carries it forward.
      ${pkgs.coreutils}/bin/chown -R santiago:users /etc/nixos/.git
      ${pkgs.util-linux}/bin/setpriv --reuid santiago --regid users --init-groups \
        ${pkgs.coreutils}/bin/env HOME=/home/santiago \
          GIT_SSH_COMMAND="${pkgs.openssh}/bin/ssh -i ${
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
