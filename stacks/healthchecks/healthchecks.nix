# healthchecks — dead-man's-switch monitor for scheduled jobs. Complements
# gatus: gatus probes live HTTP endpoints from outside ("is it up?");
# healthchecks tracks jobs that must PING on a schedule and emails when one
# stops reporting. The box's periodic units (syncoid backups, zfs snapshot/
# scrub, flake-autoupgrade) ping it — see platform/hc-ping.nix.
#
# LAN-only; traefik dials http://healthchecks:8000 over its private
# iso-bridge. Runs as the image's `hc` user (UID 999 -> host 100998),
# which owns /data.
#
# Database on the shared app-db cluster (DB=postgres below); /data holds
# only scratch state. Django migrations run automatically on container
# start (uwsgi hook-pre-app), and the image's sendalerts/sendreports
# daemons deliver notifications.
#
# SECURE_PROXY_SSL_HEADER makes Django trust traefik's X-Forwarded-Proto so
# the HTTPS-terminated login POST passes Django's CSRF origin check.
#
# Secrets: SECRET_KEY (env.sops). EMAIL_HOST_PASSWORD is rendered from
# the shared platform/mail secret — one source of truth for the Gmail
# app password.

{
  config,
  mkRootlessContainer,
  mkDotenvSecret,
  mkSecretRender,
  ...
}:

{
  fleet.bridgeMemberships.healthchecks = [ "app-db" ]; # iso-healthchecks membership comes from webApps.isolated

  fleet.statePaths."/home/santiago/selfhost/healthchecks/data".uid = 999;

  # Database on the shared app-db cluster (see stacks/app-db/).
  fleet.appDatabases.healthchecks.consumers = [ "healthchecks" ];

  fleet.webApps.healthchecks = {
    hostname = "hc.toscanini.me";
    serviceName = "healthchecks";
    port = 8000;
    # Pocket ID gate + trusted header (AUTH.md tier 2): the middleware
    # asserts the login and hands Django the email via
    # X-Forwarded-Email; REMOTE_USER_HEADER below auto-logs-in that
    # account (santiago@toscanini.me already exists — same address
    # Pocket ID asserts) and disables Django's own login.
    auth = "oidc";
    healthPath = "/accounts/login/";
    isolated = true;
    # Machine paths keep their own auth: pings are authorized by their
    # UUID, /api by X-Api-Key, badges by badge key. The companion strip
    # middleware removes spoofed X-Forwarded-Email on these.
    authBypassRule = "PathPrefix(`/ping`) || PathPrefix(`/api`) || PathPrefix(`/badge`)";
    authHeaders."X-Forwarded-Email" = "{{ .claims.email }}";
    homepage = {
      group = "Monitoring";
      extra.weight = 50;
      description = "Cron / job dead-man's-switch";
      icon = "healthchecks.png";
      # Via traefik, not uwsgi-direct: homepage's undici client trips
      # intermittently on uwsgi keep-alive and the tile flaps red.
      # /api/v1/status/ rides the auth bypass, so it stays probeable.
      siteMonitor = "https://hc.toscanini.me/api/v1/status/";
      widget = {
        type = "healthchecks";
        url = "https://hc.toscanini.me";
        key = "{{HOMEPAGE_VAR_HEALTHCHECKS_API_KEY}}";
      };
    };
  };

  sops.secrets."healthchecks-env" = mkDotenvSecret ./env.sops;

  # EMAIL_HOST_PASSWORD is the shared Gmail app password from
  # platform/mail — rendered from that single sops source (same idiom
  # as n8n's SMTP env) so rotation touches one file.
  systemd.services.healthchecks-smtp-env = mkSecretRender {
    description = "Render EMAIL_HOST_PASSWORD from the shared mail relay secret";
    gates = [ "podman-healthchecks.service" ];
    dir = "/run/healthchecks-smtp";
    file = "/run/healthchecks-smtp/env";
    content = "EMAIL_HOST_PASSWORD=$(cat ${config.sops.secrets."mail-relay-password".path})";
  };
  systemd.services.podman-healthchecks = {
    after = [ "healthchecks-smtp-env.service" ];
    wants = [ "healthchecks-smtp-env.service" ];
  };

  virtualisation.oci-containers.containers.healthchecks = mkRootlessContainer {
    image = "docker.io/healthchecks/healthchecks:v4.3@sha256:cd7bcd94350818b3944f82eb5995f48bdeab8c8627977578a569ffa73f56f56f";

    environment = {
      SITE_ROOT = "https://hc.toscanini.me";
      SITE_NAME = "s2-server";
      ALLOWED_HOSTS = "hc.toscanini.me";
      SECURE_PROXY_SSL_HEADER = "HTTP_X_FORWARDED_PROTO,https";
      # Trust the middleware-set X-Forwarded-Email as the login (Django
      # META name). Replaces email/password login entirely.
      REMOTE_USER_HEADER = "HTTP_X_FORWARDED_EMAIL";
      DEBUG = "False";
      REGISTRATION_OPEN = "False";
      # DB_PASSWORD rides the app-db bootstrap env file.
      DB = "postgres";
      DB_HOST = "pg";
      DB_PORT = "5432";
      DB_NAME = "healthchecks";
      DB_USER = "healthchecks";
      EMAIL_HOST = config.fleet.mail.smtpHost;
      EMAIL_PORT = toString config.fleet.mail.smtpPort;
      EMAIL_HOST_USER = config.fleet.mail.sender;
      EMAIL_USE_TLS = "True";
      DEFAULT_FROM_EMAIL = config.fleet.mail.sender;
    };

    environmentFiles = [
      config.sops.secrets."healthchecks-env".path
      config.fleet.appDatabases.healthchecks.envFile
      "/run/healthchecks-smtp/env"
    ];

    volumes = [
      "/home/santiago/selfhost/healthchecks/data:/data"
    ];
  };
}
