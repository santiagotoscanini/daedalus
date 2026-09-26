# healthchecks — dead-man's-switch monitor for scheduled jobs. Complements
# gatus: gatus probes live HTTP endpoints from outside ("is it up?");
# healthchecks tracks jobs that must PING on a schedule and emails when one
# stops reporting. The box's periodic units (syncoid backups, zfs snapshot/
# scrub, flake-autoupgrade) ping it — see platform/hc-ping/hc-ping.nix.
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
# Secrets: SECRET_KEY (the host's env file); EMAIL_HOST_PASSWORD is rendered
# from the shared relay secret (below).
#
# The host brings:
#   fleet.modules.healthchecks.enable       the switch (default off, as every catalog module)
#   fleet.modules.healthchecks.envSopsFile  SECRET_KEY (Django's signing key)
#   fleet.images.healthchecks               the digest-pinned image
# The operator's account is the one the proxy asserts by e-mail
# (fleet.operator.email), auto-logged-in through REMOTE_USER_HEADER.

{
  config,
  lib,
  mkRootlessContainer,
  mkDotenvSecret,
  mkSecretRender,
  pinnedImage,
  ...
}:

{
  options.fleet.modules.healthchecks = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Healthchecks — dead-man's-switch monitoring of the box's scheduled jobs.";
    };

    envSopsFile = lib.mkOption {
      type = lib.types.path;
      example = lib.literalExpression "./host/sops/healthchecks/env.sops";
      description = ''
        sops-encrypted dotenv carrying SECRET_KEY, Django's signing key —
        fixed once set, since sessions and signed tokens hang off it. Host
        data: the engine carries no box's ciphertext. Only read while the
        module is on.
      '';
    };
  };

  config =
    let
      cfg = config.fleet.modules.healthchecks;
    in
    lib.mkIf cfg.enable {
      fleet.bridgeMemberships.healthchecks = [ "app-db" ]; # iso-healthchecks membership comes from webApps.isolated

      fleet.statePaths."${config.fleet.stateRoot}/healthchecks/data".uid = 999;

      # Database on the shared app-db cluster (modules/app-db).
      fleet.appDatabases.healthchecks.consumers = [ "healthchecks" ];

      fleet.webApps.healthchecks = {
        # `hc` is the conventional label; a host that wants another defines
        # `fleet.webApps.healthchecks.hostname` itself.
        hostname = lib.mkDefault "hc.${config.fleet.baseDomain}";
        serviceName = "healthchecks";
        port = 8000;
        # Pocket ID gate + trusted header: the middleware
        # asserts the login and hands Django the email via
        # X-Forwarded-Email; REMOTE_USER_HEADER below auto-logs-in that
        # account (the operator's, created at first login — same address
        # Pocket ID asserts) and disables Django's own login.
        auth = "oidc";
        healthPath = "/accounts/login/";
        isolated = true;
        # Machine paths keep their own auth: pings are authorized by their
        # UUID, /api by X-Api-Key, badges by badge key. The companion strip
        # middleware removes spoofed X-Forwarded-Email on these.
        authBypassRule = "PathPrefix(`/ping`) || PathPrefix(`/api`) || PathPrefix(`/badge`)";
        authHeaders."X-Forwarded-Email" = "{{ .claims.email }}";
      };
      # Consent screen and Pocket ID's My Apps page.
      fleet.ssoClients.healthchecks = {
        description = "Cron / job dead-man's-switch";
      };

      sops.secrets."healthchecks-env" = mkDotenvSecret cfg.envSopsFile;

      # EMAIL_HOST_PASSWORD is the shared relay password from
      # platform/mail/mail.nix — rendered from that single sops source, not
      # copied, so rotation touches one file.
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
        image = pinnedImage "healthchecks" "docker.io/healthchecks/healthchecks";

        environment = {
          SITE_ROOT = "https://${config.fleet.webApps.healthchecks.hostname}";
          SITE_NAME = config.networking.hostName;
          ALLOWED_HOSTS = config.fleet.webApps.healthchecks.hostname;
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
          "${config.fleet.stateRoot}/healthchecks/data:/data"
        ];
      };
    };
}
