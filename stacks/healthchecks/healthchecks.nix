# healthchecks — dead-man's-switch monitor for scheduled jobs. Complements
# gatus: gatus probes live HTTP endpoints from outside ("is it up?");
# healthchecks tracks jobs that must PING on a schedule and emails when one
# stops reporting. The box's periodic units (syncoid backups, zfs snapshot/
# scrub, flake-autoupgrade) ping it — see platform/hc-ping.nix.
#
# LAN-only; traefik dials http://healthchecks:8000 over traefik-net. Runs as
# the image's `hc` user (UID 999 -> host 100998), which owns /data.
#
# SQLite state at /data/hc.sqlite (rides rpool/selfhost snapshots). Django
# migrations run automatically on container start (uwsgi hook-pre-app), and
# the image's sendalerts/sendreports daemons deliver notifications.
#
# SECURE_PROXY_SSL_HEADER makes Django trust traefik's X-Forwarded-Proto so
# the HTTPS-terminated login POST passes Django's CSRF origin check.
#
# Secrets (env.sops): SECRET_KEY + EMAIL_HOST_PASSWORD. The SMTP password is
# the same Gmail app password as platform/mail — rotate both together.

{ config, mkRootlessContainer, ... }:

{
  myStack.containerNetworks.healthchecks = "traefik";

  myStack.webApps.healthchecks = {
    hostname = "hc.toscanini.me";
    serviceName = "healthchecks";
    port = 8000;
  };

  myStack.homepageServices."Monitoring" = [
    {
      name = "Healthchecks";
      href = "https://hc.toscanini.me";
      description = "Cron / job dead-man's-switch";
      icon = "healthchecks.png";
      siteMonitor = "http://healthchecks:8000";
      widget = {
        type = "healthchecks";
        url = "http://healthchecks:8000";
        key = "{{HOMEPAGE_VAR_HEALTHCHECKS_API_KEY}}";
      };
    }
  ];

  sops.secrets."healthchecks-env" = {
    sopsFile = ./env.sops;
    format = "dotenv";
    key = "";
    owner = "santiago";
  };

  virtualisation.oci-containers.containers.healthchecks = mkRootlessContainer {
    image = "docker.io/healthchecks/healthchecks:v4.3@sha256:a5c9daf1759988defe122b6a6a29e401a76b7ea94dfffa1340245c5bcb57cb72";

    environment = {
      SITE_ROOT = "https://hc.toscanini.me";
      SITE_NAME = "s2-server";
      ALLOWED_HOSTS = "hc.toscanini.me,healthchecks";
      SECURE_PROXY_SSL_HEADER = "HTTP_X_FORWARDED_PROTO,https";
      DEBUG = "False";
      REGISTRATION_OPEN = "False";
      DB = "sqlite";
      DB_NAME = "/data/hc.sqlite";
      EMAIL_HOST = "smtp.gmail.com";
      EMAIL_PORT = "587";
      EMAIL_HOST_USER = "s2.toscanini.me@gmail.com";
      EMAIL_USE_TLS = "True";
      DEFAULT_FROM_EMAIL = "s2.toscanini.me@gmail.com";
    };

    environmentFiles = [ config.sops.secrets."healthchecks-env".path ];

    volumes = [
      "/home/santiago/selfhost/healthchecks/data:/data"
    ];

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
