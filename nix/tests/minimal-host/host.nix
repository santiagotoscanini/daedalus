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

    # The apps platform, ON: what turns a `fleet.apps` entry — the control
    # plane's own, from the engine's self.json — into a container. This is the
    # line that proves a stranger's host has a control plane to log in to.
    modules.apps.enable = true;
    # The registry the platform builds into and deploys from.
    modules.registry = {
      enable = true;
      envSopsFile = ./sops/registry/env.sops;
    };
    images.zot = "ghcr.io/project-zot/zot:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";

    # A leaf of the catalog, ON — proof that a stranger can enable a migrated
    # stack with nothing but its switch and its image pin. It writes
    # `fleet.webApps` and `fleet.ssoClients`, which the proxy and the provider
    # below act on.
    modules.stirling-pdf.enable = true;
    # The shared cluster, ON: the control plane and the provider are its
    # tenants here, so the cluster, the bootstraps and the exporter all
    # evaluate.
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
    # The tunnel, ON: public ingress for every `exposeRemotely` entry, and the
    # reconciler that keeps the zone's CNAMEs matching them.
    modules.cloudflared = {
      enable = true;
      credentialsSopsFile = ./sops/cloudflared/credentials.json.sops;
    };
    images.cloudflared = "docker.io/cloudflare/cloudflared:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    # The two monitors, ON: gatus probes every published hostname and admits
    # one subject; healthchecks receives the platform's dead-man pings.
    modules.gatus = {
      enable = true;
      allowedSubjects = [ "00000000-0000-0000-0000-000000000000" ];
    };
    images.gatus = "docker.io/twinproduction/gatus:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    modules.healthchecks = {
      enable = true;
      envSopsFile = ./sops/healthchecks/env.sops;
    };
    images.healthchecks = "docker.io/healthchecks/healthchecks:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    # The LAN resolver, ON, with no reservations file: every published
    # hostname gets a local record; no DHCP inventory, no render for it.
    modules.pihole.enable = true;
    # Metrics and dashboards, ON: Grafana takes a database on the cluster and
    # a client at the provider; the embed policy for the control plane's panels
    # names the control plane.
    modules.monitoring = {
      enable = true;
      envSopsFile = ./sops/monitoring/env.sops;
    };
    images.prometheus = "docker.io/prom/prometheus:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    images.grafana = "docker.io/grafana/grafana:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
    images.node-exporter = "docker.io/prom/node-exporter:0.0.0@sha256:0000000000000000000000000000000000000000000000000000000000000000";
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
