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

{
  config,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

{
  myStack.containerNetworks.healthchecks = "traefik";

  myStack.webApps.healthchecks = {
    hostname = "hc.toscanini.me";
    serviceName = "healthchecks";
    port = 8000;
    # Pocket ID gate + trusted header (AUTH.md tier 2): the middleware
    # asserts the login and hands Django the email via
    # X-Forwarded-Email; REMOTE_USER_HEADER below auto-logs-in that
    # account (santiago@toscanini.me already exists — same address
    # Pocket ID asserts) and disables Django's own login.
    auth = "oidc";
    # Machine paths keep their own auth: pings are authorized by their
    # UUID, /api by X-Api-Key, badges by badge key. The companion strip
    # middleware removes spoofed X-Forwarded-Email on these.
    authBypassRule = "PathPrefix(`/ping`) || PathPrefix(`/api`) || PathPrefix(`/badge`)";
    authHeaders."X-Forwarded-Email" = "{{ .claims.email }}";
    homepage = {
      group = "Monitoring";
      description = "Cron / job dead-man's-switch";
      icon = "healthchecks.png";
      # Via traefik, not uwsgi-direct: homepage's undici client trips
      # intermittently on uwsgi keep-alive (the old flapping red dot).
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

  virtualisation.oci-containers.containers.healthchecks = mkRootlessContainer {
    image = "docker.io/healthchecks/healthchecks:v4.3@sha256:cd7bcd94350818b3944f82eb5995f48bdeab8c8627977578a569ffa73f56f56f";

    environment = {
      SITE_ROOT = "https://hc.toscanini.me";
      SITE_NAME = "s2-server";
      ALLOWED_HOSTS = "hc.toscanini.me,healthchecks";
      SECURE_PROXY_SSL_HEADER = "HTTP_X_FORWARDED_PROTO,https";
      # Trust the middleware-set X-Forwarded-Email as the login (Django
      # META name). Replaces email/password login entirely.
      REMOTE_USER_HEADER = "HTTP_X_FORWARDED_EMAIL";
      DEBUG = "False";
      REGISTRATION_OPEN = "False";
      DB = "sqlite";
      DB_NAME = "/data/hc.sqlite";
      EMAIL_HOST = config.myStack.mail.smtpHost;
      EMAIL_PORT = toString config.myStack.mail.smtpPort;
      EMAIL_HOST_USER = config.myStack.mail.sender;
      EMAIL_USE_TLS = "True";
      DEFAULT_FROM_EMAIL = config.myStack.mail.sender;
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
