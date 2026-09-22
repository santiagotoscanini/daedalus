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

    # One catalog module, ON — proof that a stranger can enable a migrated
    # stack with nothing but its switch and its image pin. It writes
    # `fleet.webApps` and `fleet.ssoClients`; this host runs no reverse proxy
    # and no identity provider, so both entries are declarations nothing acts
    # on, and evaluation must not care.
    modules.stirling-pdf.enable = true;
    # The shared cluster, ON: no tenant declares a database on this host, so
    # the cluster itself is not started, but the registry, the bootstraps and
    # the exporter all evaluate.
    modules.app-db.enable = true;
    # The reverse proxy, ON: every webApp entry above now materializes into a
    # route, its own dashboard included.
    modules.traefik = {
      enable = true;
      envSopsFile = ./sops/traefik/env.sops;
    };
    images.traefik = "docker.io/library/traefik:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    # The identity provider, ON: it needs a database on the cluster, so the
    # cluster now has a tenant and starts; every `auth = "oidc"` entry above
    # gets a client, and the proxy's middleware finds its credentials.
    modules.pocket-id = {
      enable = true;
      envSopsFile = ./sops/pocket-id/env.sops;
    };
    images.pocket-id = "ghcr.io/pocket-id/pocket-id:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    # Logs, ON: the shipper's config renders from three registries no stack on
    # this host writes, so every generated section is empty and still parses.
    modules.logging.enable = true;
    images.loki = "docker.io/grafana/loki:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    images.alloy = "docker.io/grafana/alloy:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    images.app-db-exporter = "quay.io/prometheuscommunity/postgres-exporter:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    images.stirling-pdf = "docker.io/stirlingtools/stirling-pdf:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";

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
