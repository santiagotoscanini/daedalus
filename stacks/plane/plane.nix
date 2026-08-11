# plane — self-hosted project management (Community Edition).
#
# Faithful translation of upstream's Community-Edition docker-compose
# (github.com/makeplane/plane, release asset docker-compose.yml) to
# rootless oci-containers. Twelve containers on a private `plane`
# bridge; only plane-proxy also joins traefik-net.
#
#   plane-proxy   Caddy path router — the ONE ingress. Baked Caddyfile
#                 (apps/proxy/Caddyfile.ce) routes by prefix to
#                 space/admin/live/api/plane-minio/web BY HARDCODED
#                 HOSTNAME, which is why the bridge memberships below
#                 carry `:alias=` entries: our containers are
#                 plane-<x> (traefik-net demands globally unique names,
#                 and `web`/`api`/`admin` are exactly the generic names
#                 that would collide), the aliases give the image the
#                 short names its config was compiled against.
#   plane-web     the SPA (nginx serving a static build)
#   plane-space   public/shared views          (/spaces/*)
#   plane-admin   god-mode instance admin      (/god-mode/*)
#   plane-live    Hocuspocus realtime collab   (/live/*)
#   plane-api     Django/DRF + gunicorn        (/api/*, /auth/*, /static/*)
#   plane-worker  celery worker
#   plane-beat    celery beat
#   plane-redis   valkey — Django cache + live-server presence only
#   plane-mq      rabbitmq — the celery broker
#   plane-minio   S3 for attachments           (/uploads/*)
#   plane-otel    OTLP receiver → prometheus exporter (see "Metrics")
#
# Postgres is NOT one of them: the database lives on the shared app-db
# cluster (`fleet.appDatabases.plane`), reached as `pg` over app-db-net.
# The bootstrap-generated DATABASE_URL is the only DB config the API
# reads — plane/settings/common.py prefers it over the PG* vars and
# parses it with dj_database_url.
#
## Ingress
#
# Upstream expects to own :80/:443 with its own ACME. We set
# SITE_ADDRESS=:80 and hand traefik the whole thing at
# http://plane-proxy:80 — the shape upstream documents for an external
# reverse proxy. TRUSTED_PROXIES is the traefik-net subnet, and it is
# load-bearing, not hygiene: Caddy only forwards an inbound
# X-Forwarded-Proto when the peer is a trusted proxy, and
# plane/settings/production.py sets
# SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https").
# Get it wrong and Django believes every request is plaintext, which
# breaks secure-cookie issuance and the presigned upload URLs below.
#
## Auth — the Community Edition has no OIDC
#
# OIDC/SAML are paid features; the AGPL source ships exactly four OAuth
# providers (google, github, gitlab, gitea) plus email password and
# magic link. There is no OIDC code to unlock — plane/utils/
# instance_config_variables/extended.py is an empty list, the seam the
# closed-source Commercial build fills in.
#
# **This is the one web app on the box NOT behind the Pocket ID
# forward-auth gate, and that is deliberate.** A traefik gate in front
# of an app that cannot consume the identity gives you two unrelated
# identity namespaces: Pocket ID authenticates you, then Plane asks who
# you are all over again. Every person has to be provisioned twice, and
# their Plane identity — assignments, comments, permissions — has no
# link to the passkey they used at the door. Two prompts bought
# defence in depth, not identity.
#
# So Plane's own magic-link login IS the authentication here. One
# sign-in, and it is the one that actually names the user, so
# multi-user works the way Plane intends: invite by email, real
# per-user attribution, `ENABLE_SIGNUP=0` so nobody self-registers.
#
# What that costs, stated plainly: Plane's login page is reachable by
# anything on the LAN or over WireGuard. It is not published through
# the CF tunnel, so that is the whole exposure, and what is behind it
# is a real auth flow (an emailed one-time link), not a bare app.
#
# The two knobs that follow from this, both live in `backendEnv`:
#   - SESSION_COOKIE_AGE = 1 year. This is now the ONLY gate, not the
#     inner one — a year is a long time for a cookie on a borrowed
#     laptop. Shorten it if that trade stops feeling right; the cost is
#     a trip to your inbox that often.
#   - ENABLE_EMAIL_PASSWORD stays on as break-glass. Magic link is the
#     intended path, but if the SMTP relay breaks it is the ONLY path,
#     and there is no gate behind which to recover.
#
# Rejected alternatives, so they don't get re-litigated:
#   - Paying: Plane One (one-time perpetual, included OIDC) sunset
#     2026-03-14; SSO is now a quote-on-request tier AND a move to the
#     closed-source Commercial Edition — a different codebase and
#     images, not a config change.
#   - Patching CE: the live community PRs (makeplane/plane#9253, #9248)
#     are ~1000 lines across 20+ files with unsigned CLAs and no
#     maintainer engagement. SSO is the paid differentiator, so it is a
#     permanent private fork of Django auth code.
#   - Pointing the gitlab/gitea providers at Pocket ID: both hardcode
#     provider-shaped paths (/api/v4/user, /api/v1/user +
#     /api/v1/user/emails with per-address `verified` flags) that no
#     OIDC userinfo document supplies. Config can't do it; it needs a
#     translating service on the auth path.
#
## Instance configuration is seeded ONCE
#
# `configure_instance` (api entrypoint) does get_or_create per key, so
# every ENABLE_*/EMAIL_* env var below is a FIRST-BOOT SEED. After the
# instances row exists, the god-mode UI at /god-mode/ is authoritative
# and editing this file changes nothing. Re-seeding means deleting the
# row from the instance_configurations table — do it through god-mode.
#
# SECRET_KEY is doubly load-bearing: EMAIL_HOST_PASSWORD is stored
# encrypted with it, so rotating it orphans the stored SMTP password
# (and every other is_encrypted config value).
#
## Metrics
#
# Plane has no /metrics endpoint. What it does have is an OTLP push:
# beat schedules push_instance_metrics every
# METRICS_PUSH_INTERVAL_MINUTES, which observes instance- and
# workspace-level gauges and ships them to OTLP_ENDPOINT — default
# https://telemetry.plane.so. Pointing OTLP_ENDPOINT at plane-otel
# turns their telemetry pipeline into our monitoring feed AND is the
# whole of the outbound-telemetry story: with POSTHOG_API_KEY and
# SCOUT_MONITOR unset, that push is the only thing Plane's CE sends
# anywhere, and it now terminates on this box. (register_instance does
# one unauthenticated GET to the GitHub releases API for the
# update-available banner; it uploads nothing.)
#
# The gauges need `is_telemetry_enabled` on the instances row, which is
# the default — leave the god-mode Telemetry toggle ON, it no longer
# reaches Plane.
#
## Deliberately not wired
#
# Plane AI (LLM_PROVIDER/LLM_API_KEY): plane/app/views/external/base.py
# constructs OpenAI()/Anthropic() with no base_url and validates the
# model against a hardcoded allowlist, so it cannot be pointed at the
# litellm gateway without patching the image.

{
  config,
  lib,
  pkgs,
  mkDotenvSecret,
  mkRootlessContainer,
  mkSecretRender,
  ...
}:

let
  # Every image in the release moves together — upstream tags them all
  # with the same version and the compose file interpolates one
  # APP_RELEASE. Bump the version and all six digests as one change.
  planeVersion = "v1.4.0";

  hostname = "plane.${config.fleet.baseDomain}";
  webUrl = "https://${hostname}";

  # Set this to the workspace slug once one exists, and paste a
  # workspace API token into env.sops as PLANE_API_KEY, to light up the
  # project and work-item counts on daedalus's Home page. Both are
  # post-setup state — a workspace only exists after someone signs in — so
  # the default keeps the panel to the two unauthenticated version fields
  # rather than erroring against a slug that isn't there yet.

  stateRoot = "${config.fleet.stateRoot}/plane";

  secretEnv = config.sops.secrets."plane-env".path;
  dbEnv = config.fleet.appDatabases.plane.envFile;
  smtpEnv = "/run/plane-smtp/env";

  # api + worker + beat + the migrator are the same image with the same
  # configuration and different entrypoints; the only difference that
  # matters is which of them the OTLP push runs on (the worker), and
  # that is harmless everywhere.
  backendImage = "docker.io/makeplane/plane-backend:${planeVersion}@sha256:fbd4b3cea455df88e5473d01e56162286d5f61991898903d9142a7f502799481";

  backendEnv = {
    # --- ingress identity -------------------------------------------
    # CORS_ALLOWED_ORIGINS is not just CORS: common.py derives
    # `secure_origins` from it (True only when no entry contains
    # "http:") and feeds that to SESSION_COOKIE_SECURE /
    # CSRF_COOKIE_SECURE, and uses the list verbatim as
    # CSRF_TRUSTED_ORIGINS. It must be the https origin, exactly.
    WEB_URL = webUrl;
    CORS_ALLOWED_ORIGINS = webUrl;
    DEBUG = "0";
    APP_VERSION = planeVersion;

    # --- workers ----------------------------------------------------
    GUNICORN_WORKERS = "2";
    API_KEY_RATE_LIMIT = "60/minute";
    AUTHENTICATION_RATE_LIMIT = "10/minute";

    # --- cache ------------------------------------------------------
    REDIS_HOST = "plane-redis";
    REDIS_PORT = "6379";
    REDIS_URL = "redis://plane-redis:6379/";

    # --- celery broker ----------------------------------------------
    # AMQP_URL left unset so common.py assembles the URL from these
    # parts + RABBITMQ_PASSWORD (which rides env.sops) — one password,
    # no second copy embedded in a URL.
    RABBITMQ_HOST = "plane-mq";
    RABBITMQ_PORT = "5672";
    RABBITMQ_VHOST = "plane";

    # --- object storage ---------------------------------------------
    # Server-side calls (create_bucket, background tasks) use
    # AWS_S3_ENDPOINT_URL directly. Browser-facing presigned URLs are
    # built from the REQUEST host instead, so they come out as
    # https://plane.toscanini.me/uploads/... and ride the Caddyfile's
    # /uploads/* route back to minio — the SigV4 signature covers Host,
    # and Caddy passes the original one through.
    #
    # MINIO_ENDPOINT_SSL=1 pins that scheme to https unconditionally
    # rather than inferring it from request.scheme. Belt and braces
    # with TRUSTED_PROXIES: if the forwarded-proto chain ever breaks,
    # this is the difference between working uploads and a browser
    # blocking mixed content (makeplane/plane#7739).
    USE_MINIO = "1";
    MINIO_ENDPOINT_SSL = "1";
    AWS_S3_ENDPOINT_URL = "http://plane-minio:9000";
    AWS_S3_BUCKET_NAME = "uploads";
    AWS_REGION = "";
    FILE_SIZE_LIMIT = toString fileSizeLimit;
    SIGNED_URL_EXPIRATION = "3600";

    # --- sessions ---------------------------------------------------
    # One year: see the auth note in the header.
    SESSION_COOKIE_AGE = "31536000";

    # --- first-boot instance-configuration seeds --------------------
    # get_or_create only; god-mode owns these after the first start.
    ENABLE_SIGNUP = "0";
    ENABLE_EMAIL_PASSWORD = "1";
    ENABLE_MAGIC_LINK_LOGIN = "1";
    DISABLE_WORKSPACE_CREATION = "0";
    ENABLE_SMTP = "1";
    EMAIL_HOST = config.fleet.mail.smtpHost;
    EMAIL_PORT = toString config.fleet.mail.smtpPort;
    EMAIL_HOST_USER = config.fleet.mail.sender;
    EMAIL_FROM = "Plane <${config.fleet.mail.sender}>";
    EMAIL_USE_TLS = "1";
    EMAIL_USE_SSL = "0";

    # --- Plane AI, pointed at the litellm gateway --------------------
    # plane/app/views/external/base.py builds `OpenAI(api_key=...)` with
    # no base_url, and openai-python >= 1.x falls back to this env var
    # before defaulting to api.openai.com — so this is the whole
    # redirect. Nothing else in the codebase imports the OpenAI SDK.
    #
    # Reachability is incidental, not designed: plane-api and litellm
    # both sit on app-db-net (each for its own database). If litellm
    # ever leaves that bridge, the AI assistant starts failing with a
    # connection error and nothing else breaks — give them a shared
    # bridge at that point.
    #
    # The MODEL name is the part this env var can't fix:
    # get_llm_config() validates the god-mode "LLM Model" field against
    # a hardcoded allowlist (gpt-3.5-turbo, gpt-4o-mini, gpt-4o,
    # o1-mini, o1-preview) and bails before calling out. So litellm has
    # to answer to one of those five names.
    #
    # That is done with a PER-KEY alias on litellm's `plane` virtual key
    # (`aliases: {gpt-4o-mini: gemma-4-12b}`), not a config.yaml entry —
    # a global entry called gpt-4o-mini would show up in Open WebUI's
    # model picker as something that looks like OpenAI and isn't. Two
    # gotchas if it ever needs rebuilding: the key's `models` allowlist
    # is checked against the REQUESTED name before the alias resolves,
    # so it must list BOTH names; and the key lives in litellm's DB, so
    # it is not in this repo — `/key/list` on the gateway is the record.
    # The god-mode "API key" field holds that virtual key, which is
    # itself undeclarable instance state (see the seeding note below).
    OPENAI_BASE_URL = "http://litellm:4000/v1";

    # --- telemetry, redirected --------------------------------------
    OTLP_ENDPOINT = "http://plane-otel:4317";
    OTLP_METRICS_PROTOCOL = "grpc";
    OTEL_EXPORTER_OTLP_METRICS_INSECURE = "true";
    METRICS_PUSH_INTERVAL_MINUTES = toString metricsPushMinutes;
    SERVICE_NAME = "plane";
  };

  backendEnvFiles = [
    secretEnv
    dbEnv
    smtpEnv
  ];

  # 20 MiB. Two places have to agree or the failure is a confusing 413
  # from Caddy on a file Django would have accepted: the API signs the
  # upload with a content-length-range condition built from
  # FILE_SIZE_LIMIT, and the proxy enforces `request_body max_size`
  # from the same value.
  fileSizeLimit = 20 * 1024 * 1024;

  # Prometheus scrapes plane-otel every 15s but the gauges only refresh
  # on this cadence; 10 minutes is fine resolution for counts that move
  # a handful of times a day, and keeps the beat task cheap (it does a
  # full COUNT(*) sweep per push).
  metricsPushMinutes = 10;
in
{
  # SECRET_KEY, LIVE_SERVER_SECRET_KEY, the minio root/S3 credential
  # pair (same value under both names, so minio and the API cannot
  # drift), and the rabbitmq password under both the broker's
  # RABBITMQ_DEFAULT_PASS and the API's RABBITMQ_PASSWORD. One file for
  # the stack, as immich does — every consumer reads the whole dotenv.
  # Edit with `sops env.sops`.
  sops.secrets."plane-env" = mkDotenvSecret ./env.sops;

  # EMAIL_HOST_PASSWORD has to be in the API's environment on FIRST
  # boot (configure_instance seeds it, encrypted, into the DB). The
  # single source is the shared relay secret in platform/mail — this
  # renders it under the name Plane reads instead of keeping a second
  # copy in env.sops.
  systemd.services."plane-smtp-env" = mkSecretRender {
    description = "Render EMAIL_HOST_PASSWORD from the shared mail relay secret";
    gates = [
      "podman-plane-api.service"
      "podman-plane-worker.service"
      "podman-plane-beat.service"
    ];
    dir = "/run/plane-smtp";
    file = smtpEnv;
    content = "EMAIL_HOST_PASSWORD=$(cat ${config.sops.secrets."mail-relay-password".path})";
  };

  # Private bridge for the stack's internal DNS; only the proxy also
  # joins traefik-net. The `:alias=` suffixes exist because the proxy
  # image's Caddyfile is compiled against upstream's compose service
  # names — see the header.
  fleet.bridgeMemberships = {
    plane-proxy = [
      "plane"
      "traefik"
    ];
    plane-web = [ "plane:alias=web" ];
    plane-space = [ "plane:alias=space" ];
    plane-admin = [ "plane:alias=admin" ];
    plane-live = [ "plane:alias=live" ];
    plane-api = [
      "plane:alias=api"
      "app-db"
    ];
    plane-worker = [
      "plane"
      "app-db"
    ];
    plane-beat = [
      "plane"
      "app-db"
    ];
    plane-redis = [ "plane" ];
    plane-mq = [ "plane" ];
    plane-minio = [ "plane" ];
    # monitoring, not traefik: prometheus sits on both bridges and the
    # collector has no reason to be dialable from every web container
    # on the shared one.
    plane-otel = [
      "plane"
      "monitoring"
    ];
  };

  fleet.logStacks.plane = [
    "plane-proxy"
    "plane-web"
    "plane-space"
    "plane-admin"
    "plane-live"
    "plane-api"
    "plane-worker"
    "plane-beat"
    "plane-redis"
    "plane-mq"
    "plane-minio"
    "plane-otel"
  ];

  fleet.statePaths = {
    # minio runs as container root -> santiago.
    "${stateRoot}/minio".uid = 0;
    # rabbitmq's entrypoint drops to rabbitmq (uid 100, gid 101 in the
    # alpine image) before starting the server.
    "${stateRoot}/rabbitmq" = {
      uid = 100;
      gid = 101;
    };
  };

  # Database + login role on the shared cluster. `consumers` covers
  # every container that reads DATABASE_URL; the migrator oneshot below
  # orders itself after the bootstrap separately (it is not a
  # container, so it can't ride this list).
  fleet.appDatabases.plane.consumers = [
    "plane-api"
    "plane-worker"
    "plane-beat"
  ];

  fleet.webApps.plane = {
    inherit hostname;
    serviceName = "plane-proxy";
    port = 80;
    # LAN only — no exposeRemotely.
    #
    # `auth = "none"` is the load-bearing line, not an omission: Plane
    # authenticates its own users (magic link), and stacking a Pocket ID
    # gate in front would add a second prompt that names nobody. See the
    # auth section in the header before adding one back.
    auth = "none";
    # Unauthenticated by design (the login screen fetches it to learn
    # which providers are enabled), so the gatus probe certifies the
    # real Django app behind the whole proxy chain rather than the
    # landing page.
    healthPath = "/api/instances/";
  };

  fleet.prometheusScrapes = [
    {
      job_name = "plane";
      static_configs = [ { targets = [ "plane-otel:8889" ]; } ];
    }
  ];

  fleet.grafanaDashboardsByFolder."Services".plane = builtins.readFile ./assets/dashboard.json;

  # Migrations run to completion before anything that serves traffic.
  # Not an oci-container: `podman run -d` returns immediately, so a
  # declared container would let the API start against an unmigrated
  # schema — and the api/worker/beat entrypoints call
  # wait_for_migrations, which loops FOREVER if nothing ever applies
  # them. A oneshot also makes a failed migration a failed unit
  # (monitoredJobs mails it) instead of a silent exited container.
  #
  # The ExecStart string embeds the image digest, so bumping
  # planeVersion re-runs this before the new API comes up — the upgrade
  # path needs no manual step.
  systemd.services.plane-migrate = {
    description = "Apply Plane database migrations";
    after = [
      "podman-pg.service"
      "app-db-plane-bootstrap.service"
      "podman-network-app-db-net.service"
      "podman-network-plane-net.service"
    ];
    wants = [
      "podman-pg.service"
      "app-db-plane-bootstrap.service"
      "podman-network-app-db-net.service"
      "podman-network-plane-net.service"
    ];
    before = [
      "podman-plane-api.service"
      "podman-plane-worker.service"
      "podman-plane-beat.service"
    ];
    wantedBy = [
      "podman-plane-api.service"
      "podman-plane-worker.service"
      "podman-plane-beat.service"
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "santiago";
      Environment = "XDG_RUNTIME_DIR=/run/user/1000";
      # The bootstrap may still be creating the role on a cold boot,
      # and pg itself may be replaying WAL.
      Restart = "on-failure";
      RestartSec = "15s";
    };
    path = [ pkgs.podman ];
    script = ''
      set -eu
      exec podman run --rm --name=plane-migrate \
        --network=app-db-net --network=plane-net \
        ${lib.concatMapStringsSep " " (f: "--env-file=${f}") backendEnvFiles} \
        ${
          lib.concatStringsSep " " (lib.mapAttrsToList (k: v: "-e ${k}=${lib.escapeShellArg v}") backendEnv)
        } \
        ${backendImage} \
        ./bin/docker-entrypoint-migrator.sh
    '';
  };

  fleet.monitoredJobs.plane-migrate = { };

  # ---------------------------------------------------------------
  # Data plane
  # ---------------------------------------------------------------

  # No volume: this is a Django cache and the live server's presence
  # store. Everything in it is derivable, and a bind mount would buy a
  # uid-mapping trap for nothing (same call as immich-redis).
  virtualisation.oci-containers.containers.plane-redis = mkRootlessContainer {
    image = "docker.io/valkey/valkey:7.2.11-alpine@sha256:10328d00120dc14fbc87b2ed61b7677ddbb0d011e705361b4788329a0ec69a93";
  };

  # Persisted, unlike redis: an in-flight email-notification task is
  # not derivable. The cost of persistence is that RABBITMQ_DEFAULT_*
  # only apply to an EMPTY data dir — rotating the broker password in
  # env.sops needs the directory cleared, or the API will hold the new
  # password while the broker still wants the old one.
  virtualisation.oci-containers.containers.plane-mq = mkRootlessContainer {
    image = "docker.io/library/rabbitmq:3.13.6-management-alpine@sha256:611107e29cce05c2acd968325d5dcbde7e2fee404970f1ead75fdb22be2821b3";
    volumes = [ "${stateRoot}/rabbitmq:/var/lib/rabbitmq" ];
    # RABBITMQ_DEFAULT_{USER,PASS,VHOST} ride env.sops.
    environmentFiles = [ secretEnv ];
  };

  virtualisation.oci-containers.containers.plane-minio = mkRootlessContainer {
    image = "docker.io/minio/minio:RELEASE.2025-09-07T16-13-09Z@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e";
    # An explicit release tag, not :latest — but note this IS the last
    # community release MinIO published (Sept 2025); the tag is frozen
    # upstream, not just here.
    cmd = [
      "server"
      "/export"
    ];
    volumes = [ "${stateRoot}/minio:/export" ];
    # MINIO_ROOT_USER / MINIO_ROOT_PASSWORD ride env.sops, holding the
    # same values the API knows as AWS_ACCESS_KEY_ID / SECRET.
    environmentFiles = [ secretEnv ];
  };

  # OTLP gRPC in, prometheus text out. Config is a /nix/store path, so
  # editing assets/otel-config.yaml changes the volume spec, which
  # changes the unit, which restarts the collector.
  virtualisation.oci-containers.containers.plane-otel = mkRootlessContainer {
    image = "ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:0.157.0@sha256:4eb842091c796156d4d3c994eb22ba793590f5723719dbf6b8436cb4dfc17f48";
    volumes = [ "${./assets/otel-config.yaml}:/etc/otelcol-contrib/config.yaml:ro" ];
  };

  # ---------------------------------------------------------------
  # Application
  # ---------------------------------------------------------------

  virtualisation.oci-containers.containers.plane-api = mkRootlessContainer {
    image = backendImage;
    cmd = [ "./bin/docker-entrypoint-api.sh" ];
    dependsOn = [
      "plane-redis"
      "plane-mq"
      "plane-minio"
    ];
    environment = backendEnv;
    environmentFiles = backendEnvFiles;
  };

  virtualisation.oci-containers.containers.plane-worker = mkRootlessContainer {
    image = backendImage;
    cmd = [ "./bin/docker-entrypoint-worker.sh" ];
    dependsOn = [
      "plane-redis"
      "plane-mq"
      "plane-minio"
    ];
    environment = backendEnv;
    environmentFiles = backendEnvFiles;
  };

  virtualisation.oci-containers.containers.plane-beat = mkRootlessContainer {
    image = backendImage;
    cmd = [ "./bin/docker-entrypoint-beat.sh" ];
    dependsOn = [
      "plane-redis"
      "plane-mq"
    ];
    environment = backendEnv;
    environmentFiles = backendEnvFiles;
  };

  virtualisation.oci-containers.containers.plane-web = mkRootlessContainer {
    image = "docker.io/makeplane/plane-frontend:${planeVersion}@sha256:8f0f5ee02169c3435fa178aa60707920bfc398bff2ebbe83e72881c029d5fe56";
  };

  virtualisation.oci-containers.containers.plane-space = mkRootlessContainer {
    image = "docker.io/makeplane/plane-space:${planeVersion}@sha256:6ef9b14ca5be4f5e09cae2d452478954e18dd5f6f417a655aac13fa3e502e2d9";
  };

  virtualisation.oci-containers.containers.plane-admin = mkRootlessContainer {
    image = "docker.io/makeplane/plane-admin:${planeVersion}@sha256:8fd95429127eaaf9feb47f1e25f7db4e29aad1f66109a19bdd86a19bca660482";
  };

  virtualisation.oci-containers.containers.plane-live = mkRootlessContainer {
    image = "docker.io/makeplane/plane-live:${planeVersion}@sha256:046c38a1c091e6bce9ce79cf89a300bd226bd749f8f62e7ba7871ab853455f16";
    environment = {
      # Bridge alias, not the container name — plane-api answers to
      # both, and this keeps the value identical to upstream's.
      API_BASE_URL = "http://api:8000";
      CORS_ALLOWED_ORIGINS = webUrl;
      LIVE_BASE_PATH = "/live";
      REDIS_URL = "redis://plane-redis:6379/";
    };
    # LIVE_SERVER_SECRET_KEY — the same value the API holds; the two
    # authenticate to each other with it.
    environmentFiles = [ secretEnv ];
  };

  virtualisation.oci-containers.containers.plane-proxy = mkRootlessContainer {
    image = "docker.io/makeplane/plane-proxy:${planeVersion}@sha256:53393d2ec8c3cf2585473bcc04342c1a3a5525d61d163da13a613c79793fd600";
    dependsOn = [
      "plane-web"
      "plane-api"
      "plane-space"
      "plane-admin"
      "plane-live"
      "plane-minio"
    ];
    environment = {
      # `:80` and no CERT_EMAIL: plain HTTP, no ACME. Caddy would
      # otherwise try to issue a certificate for a hostname it cannot
      # be reached on, and double TLS would break the traefik hop.
      SITE_ADDRESS = ":80";
      APP_DOMAIN = hostname;
      BUCKET_NAME = "uploads";
      FILE_SIZE_LIMIT = toString fileSizeLimit;
      # See the ingress note in the header — this is what makes Caddy
      # forward traefik's X-Forwarded-Proto instead of overwriting it.
      TRUSTED_PROXIES = config.fleet.bridgeSubnets.traefik;
    };
  };
}
