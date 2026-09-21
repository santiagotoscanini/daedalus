{ config, ... }:
{
  # ── what any NixOS evaluation needs ──────────────────────────────────
  fileSystems."/" = {
    device = "tank/root";
    fsType = "zfs";
  };
  boot.loader.systemd-boot.enable = true;
  networking.hostName = "box";
  networking.hostId = "8425e349"; # the platform enables ZFS
  system.stateVersion = "25.11";

  users.users.${config.fleet.operator.user} = {
    inherit (config.fleet.operator) uid;
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    linger = true;
  };

  # ── what the ENGINE requires a host to define ────────────────────────
  fleet = {
    # NOT a host fact — a statement of where the migration is. The apps stack
    # (what turns a `fleet.apps` entry, the control plane's own included, into a
    # container) has not moved into the engine yet, so a host that has only the
    # engine has nothing behind this switch. Delete this line the day
    # `nix/modules/apps` exists: the check then proves the container too.
    modules.apps.enable = false;

    operator = {
      user = "alice";
      uid = 1000;
      email = "alice@example.org";
      gitName = "Alice Example";
      gitEmail = "alice@example.org";
    };
    config.repo = "/etc/nixos";
    github.owner = "alice";
    github.expectedOwnerId = 1;
    site.source = ./site;
    data = { };
    mail.smtpHost = "smtp.example.org";
    mail.passwordSopsFile = ./sops/smtp-password.sops;
    git.sshKeySopsFile = ./sops/git-ssh-key.sops;
    daedalus.serviceKeysSopsFile = ./sops/service-keys.sops;
  };
}
