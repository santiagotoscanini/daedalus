# supabase — full self-hosted Supabase: 13 containers on a single
# supabase-net bridge, fronted by Traefik on two routes
# (studio.s2.toscanini.me + supabase.s2.toscanini.me).
#
# Architecture in one paragraph:
#   supabase-db is custom Postgres 15 (pgsodium / pg_jwt / vault / etc.).
#   Seven internal-only API services (auth, rest, realtime, storage,
#   imgproxy, meta, edge-functions) sit on the bridge with short DNS
#   aliases matching the compose service names — because the upstream
#   kong.yml addresses them by those short names. Kong proxies all
#   external API traffic on :8000. Traefik fronts two routes: Studio at
#   :3001 and Kong at :8000. Supavisor (connection pooler) publishes
#   :5432 / :6543 directly on the LAN for psql clients. Vector reads
#   container logs via the rootless podman user socket
#   (/run/user/1000/podman/podman.sock — linger=true on santiago keeps
#   it up). Logflare stores them in the _analytics schema in the same DB.
#
# Why no custom entrypoints anywhere: docker-compose substitutes
# `${VAR}` into env var values at deploy time, so by the time the
# container starts, GOTRUE_JWT_SECRET / PGRST_DB_URI / etc. all hold
# their final string values. We do the same substitution at env-file-
# generation time — see /etc/nixos/containers/supabase/env. Every
# container then just reads `environmentFiles = [ envFile ]` and uses
# its image's default ENTRYPOINT/CMD. The trade-off is the env file is
# longer (~110 lines) and a JWT_SECRET / POSTGRES_PASSWORD rotation
# touches multiple derived lines, but the nix module stays minimal and
# we don't guess at image binary paths.
#
# What's load-bearing and what isn't:
#   - images.db pin is load-bearing: the on-disk cluster in
#     ${hostRoot}/db/data was initdb'd by this image. Bumping it
#     without a pg_upgrade dance will fail to start.
#   - Init SQL files (mounted under /docker-entrypoint-initdb.d/...) are
#     load-bearing on FIRST BOOT only. They create the supabase_admin /
#     anon / authenticator / service_role roles and the _supabase /
#     _analytics / _realtime / _pooler schemas. If the DB comes up with
#     an empty data dir and these missing, the cluster is unsalvageable
#     — rm -rf db/data and rebuild.
#   - JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY in the env file are
#     cryptographically coupled. Rotating JWT_SECRET invalidates the
#     other two and every user JWT issued so far.
#
# Network alias map (Kong's kong.yml and the supabase-js client
# hardcode these short names):
#   supabase-db                  → db
#   supabase-meta                → meta
#   supabase-auth                → auth
#   supabase-rest                → rest
#   supabase-realtime            → realtime-dev.supabase-realtime
#                                  (Kong's URL; realtime parses the
#                                   subdomain to derive its tenant ID)
#   supabase-storage             → storage
#   supabase-imgproxy            → imgproxy
#   supabase-edge-functions      → functions
#   supabase-analytics           → analytics
#   supabase-kong                → kong + api-gw
#   supabase-studio              → studio
#   supabase-vector              → vector
#
# Verification after rebuild (see also CLAUDE.md smoke pattern):
#   curl -sk --resolve supabase.s2.toscanini.me:443:192.168.0.2 \
#        -o /dev/null -w "%{http_code}\n" \
#        https://supabase.s2.toscanini.me/auth/v1/health
#   # expect: 200

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  # Image tags — single source of truth. Tracks supabase/supabase
  # master's docker-compose.yml. Bumping each line here is the only
  # place an upgrade lives.
  images = {
    db        = "docker.io/supabase/postgres:15.8.1.085";
    studio    = "docker.io/supabase/studio:2026.04.27-sha-5f60601";
    kong      = "docker.io/kong/kong:3.9.1";
    auth      = "docker.io/supabase/gotrue:v2.186.0";
    rest      = "docker.io/postgrest/postgrest:v14.8";
    realtime  = "docker.io/supabase/realtime:v2.76.5";
    storage   = "docker.io/supabase/storage-api:v1.48.26";
    imgproxy  = "docker.io/darthsim/imgproxy:v3.30.1";
    meta      = "docker.io/supabase/postgres-meta:v0.96.3";
    functions = "docker.io/supabase/edge-runtime:v1.71.2";
    analytics = "docker.io/supabase/logflare:1.36.1";
    vector    = "docker.io/timberio/vector:0.53.0-alpine";
    pooler    = "docker.io/supabase/supavisor:2.7.4";
    db-exporter = "quay.io/prometheuscommunity/postgres-exporter:v0.18.1";
  };

  envFile  = "/etc/nixos/containers/supabase/env";
  hostRoot = "/home/santiago/selfhost/supabase";
  dbInit   = "${hostRoot}/db-init";

  # Common bridge attach string. Single source of truth so adding a
  # new alias is a one-line change.
  net = alias: "--network=supabase-net:alias=${alias}";
in
{
  # 14 containers, all on the same bridge.
  myStack.containerNetworks = {
    supabase-db             = "supabase";
    supabase-db-exporter    = "supabase";
    supabase-meta           = "supabase";
    supabase-auth           = "supabase";
    supabase-rest           = "supabase";
    supabase-realtime       = "supabase";
    supabase-imgproxy       = "supabase";
    supabase-storage        = "supabase";
    supabase-edge-functions = "supabase";
    supabase-analytics      = "supabase";
    supabase-vector         = "supabase";
    supabase-pooler         = "supabase";
    supabase-kong           = "supabase";
    supabase-studio         = "supabase";
  };

  # Two public-facing routes. Internal API services (auth/rest/realtime
  # /etc.) are reached only through Kong, so they have no Traefik
  # routes here. Traefik dials each upstream via
  # host.containers.internal:<published host port>; both routes use
  # `entrypoint = "websecure"` (the default — HTTPS via tls-opts@file).
  myStack.traefikRoutes.supabase-studio = {
    host = "studio.s2.toscanini.me";
    # Studio listens on 3000 inside the container. Host 3000 is taken
    # by grafana, 3001 by homepage. Use 3003. (Bumping past 3002 leaves
    # room for one more 3xxx tile without re-shuffling.)
    port = 3003;
  };
  myStack.traefikRoutes.supabase-kong = {
    host = "supabase.s2.toscanini.me";
    # Host 8000 is taken by gluetun (the tv-stack VPN container exposes
    # its HTTP control API there). We publish Kong on 8400 instead.
    # Internal Kong listener is still :8000 (KONG_HTTP_PORT in env file).
    port = 8400;
  };

  # Supavisor publishes Postgres ports on the LAN. The pi-hole-served
  # DHCP scope plus everyone-on-the-LAN psql access is fine for our
  # threat model; rotate POSTGRES_PASSWORD if anything sensitive lands
  # in the DB and we ever expose it more widely.
  networking.firewall.allowedTCPPorts = [ 5432 6543 ];

  # Vector talks to rootless podman over its user socket. linger=true
  # for santiago in configuration.nix already keeps user@1000.service
  # up at boot; this wantedBy makes the user socket itself auto-start.
  # Combined, /run/user/1000/podman/podman.sock is live before
  # podman-supabase-vector.service starts.
  systemd.user.sockets.podman.wantedBy = [ "sockets.target" ];

  # systemd-tmpfiles creates bind-mount target dirs at activation with
  # the right rootless-podman UID mapping. The supabase/postgres image
  # runs as UID 70 inside the container, which maps to host 100069
  # (= 99999 + 70). The other apps in this stack run as container
  # root, which maps to santiago (1000:100). Declarative — no separate
  # `chown -R` step at deploy time.
  systemd.tmpfiles.rules = [
    "d ${hostRoot}                       0755 santiago users  -"
    "d ${hostRoot}/db                    0755 santiago users  -"
    # supabase/postgres:15.8.x runs postgres as container UID 105
    # (Debian-style), not UID 70 (Alpine-style). Host UID = 99999 + 105
    # = 100104. Earlier I had 100069 (= 99999 + 70) which broke postgres
    # on every nixos-rebuild because systemd-tmpfiles re-enforces
    # ownership at activation time, chown'ing the data dir away from
    # the user postgres actually runs as. CLAUDE.md's UID-mapping table
    # listed 100069 for postgres — true for older Alpine-based images,
    # NOT for this one.
    "d ${hostRoot}/db/data               0700 100104   100105 -"
    # /etc/postgresql-custom holds the pgsodium decryption key
    # generated on first DB boot plus the image-shipped wal-g.conf /
    # read-replica.conf / supautils.conf. We bind-mount it (under
    # /home/santiago/selfhost so it's on the same rpool/selfhost
    # dataset as the rest of the stack and shows up in any backup of
    # that tree) rather than using a podman named volume (which would
    # live in ~santiago/.local/share/containers/storage/volumes/ —
    # outside any backup plan). The empty bind target is seeded from
    # the image on first boot by systemd.services.supabase-db-config-seed
    # below; postgresql.conf's `include = '/etc/postgresql-custom/...'`
    # only succeeds because of that seed.
    "d ${hostRoot}/db-config             0700 100104   100105 -"
    #
    # Storage lives on the s2-pool HDD mirror (/s2/supabase-storage,
    # the s2-pool/supabase-storage dataset declared in
    # configuration.nix). One subdir per Supabase project — the
    # composer will add more siblings (e.g. /s2/supabase-storage/voyra)
    # without touching this module. STORAGE_TENANT_ID in the env file
    # picks which subdir this deployment writes to.
    "d /s2/supabase-storage/s2-server    0755 santiago users  -"
    "d ${hostRoot}/snippets              0755 santiago users  -"
    "d ${hostRoot}/studio                0755 santiago users  -"
    "d ${hostRoot}/functions             0755 santiago users  -"
    "d ${hostRoot}/functions/main        0755 santiago users  -"
    "d ${hostRoot}/logs                  0755 santiago users  -"
  ];

  # ── db ────────────────────────────────────────────────────────────
  # Custom supabase/postgres image: stock Postgres 15 + pgsodium,
  # pg_jwt, pg_cron, vault, plv8, supautils, etc. Do NOT swap for
  # docker.io/library/postgres:15-alpine — the schemas Supabase creates
  # at init time require these extensions.
  #
  # POSTGRES_HOST inside this container is a Unix socket. The env file
  # exposes POSTGRES_HOST=db (the bridge alias) for the OTHER
  # containers; the explicit `environment` block here overrides that
  # for db itself. Without this override, pg_isready and the init
  # scripts try to dial `db:5432` and fail because the listener isn't
  # ready yet during init.
  virtualisation.oci-containers.containers.supabase-db = mkRootlessContainer {
    image = images.db;

    volumes = [
      "${hostRoot}/db/data:/var/lib/postgresql/data"
      # Bind-mounted (not named-volumed) — see the tmpfiles comment
      # above. The bind target is empty on first boot; the seed
      # service below populates it from the image before this
      # container starts.
      "${hostRoot}/db-config:/etc/postgresql-custom"
      # Init SQL bundle. Path layout copied verbatim from upstream
      # compose — load-bearing on first boot.
      "${dbInit}/_supabase.sql:/docker-entrypoint-initdb.d/migrations/97-_supabase.sql:ro"
      "${dbInit}/realtime.sql:/docker-entrypoint-initdb.d/migrations/99-realtime.sql:ro"
      "${dbInit}/logs.sql:/docker-entrypoint-initdb.d/migrations/99-logs.sql:ro"
      "${dbInit}/pooler.sql:/docker-entrypoint-initdb.d/migrations/99-pooler.sql:ro"
      "${dbInit}/webhooks.sql:/docker-entrypoint-initdb.d/init-scripts/98-webhooks.sql:ro"
      "${dbInit}/roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:ro"
      "${dbInit}/jwt.sql:/docker-entrypoint-initdb.d/init-scripts/99-jwt.sql:ro"
    ];

    environment = {
      POSTGRES_HOST = "/var/run/postgresql";
    };

    environmentFiles = [ envFile ];

    cmd = [
      "postgres"
      "-c" "config_file=/etc/postgresql/postgresql.conf"
      # Silences the realtime tenant-polling queries that would
      # otherwise flood the logs at 200ms intervals.
      "-c" "log_min_messages=fatal"
    ];

    extraOptions = [ (net "db") ];
  };

  # Seeds /etc/postgresql-custom on first boot from the image's own
  # /etc/postgresql-custom — supautils.conf, wal-g.conf,
  # read-replica.conf. Idempotent: only runs if the bind-target is
  # empty. Replaces what `podman volume create` auto-populating from
  # the image would have done for a named volume.
  systemd.services.supabase-db-config-seed = {
    description = "Seed supabase-db /etc/postgresql-custom bind mount on first boot";
    after = [ "network-online.target" "local-fs.target" ];
    wants = [ "network-online.target" ];
    before = [ "podman-supabase-db.service" ];
    wantedBy = [ "podman-supabase-db.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "santiago";
      Environment = "XDG_RUNTIME_DIR=/run/user/1000";
      Restart = "on-failure";
      RestartSec = "10s";
      ExecStart = pkgs.writeShellScript "supabase-db-config-seed" ''
        set -eu
        DST="${hostRoot}/db-config"
        if [ -n "$(ls -A "$DST" 2>/dev/null || true)" ]; then
          echo "$DST is already populated — skipping seed."
          exit 0
        fi
        echo "Seeding $DST from ${images.db}..."
        ${pkgs.podman}/bin/podman run --rm \
          --entrypoint=/bin/sh \
          -v "$DST":/seed-target \
          ${images.db} \
          -c 'cp -r /etc/postgresql-custom/. /seed-target/'
        echo "Done."
      '';
    };
  };

  # ── meta ──────────────────────────────────────────────────────────
  # postgres-meta — DB introspection API consumed by Studio's table
  # editor. Listens on :8080 internally; reached as `meta:8080` from
  # Kong + Studio. PG_META_DB_PASSWORD and CRYPTO_KEY are baked into
  # the env file (aliased from POSTGRES_PASSWORD / PG_META_CRYPTO_KEY).
  virtualisation.oci-containers.containers.supabase-meta = mkRootlessContainer {
    image = images.meta;
    dependsOn = [ "supabase-db" ];

    environment = {
      PG_META_PORT    = "8080";
      PG_META_DB_HOST = "db";
      PG_META_DB_PORT = "5432";
      PG_META_DB_NAME = "postgres";
      PG_META_DB_USER = "supabase_admin";
    };

    environmentFiles = [ envFile ];

    extraOptions = [ (net "meta") ];
  };

  # ── auth (GoTrue) ─────────────────────────────────────────────────
  # GoTrue auth server. Listens on :9999. Reads its config from
  # GOTRUE_* env vars baked into the env file at generation time.
  # Email signup with ENABLE_EMAIL_AUTOCONFIRM=true (set in env file)
  # so accounts work without a real SMTP server — flip to false once
  # you wire SMTP credentials in.
  virtualisation.oci-containers.containers.supabase-auth = mkRootlessContainer {
    image = images.auth;
    dependsOn = [ "supabase-db" ];

    environment = {
      GOTRUE_API_HOST              = "0.0.0.0";
      GOTRUE_API_PORT              = "9999";
      GOTRUE_DB_DRIVER             = "postgres";
      GOTRUE_JWT_ADMIN_ROLES       = "service_role";
      GOTRUE_JWT_AUD               = "authenticated";
      GOTRUE_JWT_DEFAULT_GROUP_NAME = "authenticated";
      API_EXTERNAL_URL             = "https://supabase.s2.toscanini.me";
    };

    environmentFiles = [ envFile ];

    extraOptions = [ (net "auth") ];
  };

  # ── rest (PostgREST) ──────────────────────────────────────────────
  # PostgREST. Listens on :3000. Reached as `rest:3000` from Kong.
  # Connects as `authenticator`; PostgREST sets the role per-request
  # based on the JWT.
  virtualisation.oci-containers.containers.supabase-rest = mkRootlessContainer {
    image = images.rest;
    dependsOn = [ "supabase-db" ];

    environment = {
      PGRST_DB_ANON_ROLE       = "anon";
      PGRST_DB_USE_LEGACY_GUCS = "false";
    };

    environmentFiles = [ envFile ];

    cmd = [ "postgrest" ];

    extraOptions = [ (net "rest") ];
  };

  # ── realtime ──────────────────────────────────────────────────────
  # Phoenix-based WebSocket service. Listens on :4000. Kong dials it
  # at `realtime-dev.supabase-realtime:4000` — that hostname is
  # load-bearing because realtime extracts the tenant ID from the
  # subdomain portion (`realtime-dev`). We use a bridge alias rather
  # than naming the container with a dot (cleaner nix attribute).
  virtualisation.oci-containers.containers.supabase-realtime = mkRootlessContainer {
    image = images.realtime;
    dependsOn = [ "supabase-db" ];

    environment = {
      PORT                       = "4000";
      DB_USER                    = "supabase_admin";
      DB_AFTER_CONNECT_QUERY     = "SET search_path TO _realtime";
      DB_ENC_KEY                 = "supabaserealtime";  # 16 chars — AES-128 key
      ERL_AFLAGS                 = "-proto_dist inet_tcp";
      DNS_NODES                  = "''";
      RLIMIT_NOFILE              = "10000";
      APP_NAME                   = "realtime";
      SEED_SELF_HOST             = "true";
      RUN_JANITOR                = "true";
      DISABLE_HEALTHCHECK_LOGGING = "true";
    };

    environmentFiles = [ envFile ];

    extraOptions = [ (net "realtime-dev.supabase-realtime") ];
  };

  # ── imgproxy ──────────────────────────────────────────────────────
  # Image transformer. No DB. Shares the storage bind mount with
  # supabase-storage so it can transform-and-serve images by file path.
  virtualisation.oci-containers.containers.supabase-imgproxy = mkRootlessContainer {
    image = images.imgproxy;

    volumes = [
      "/s2/supabase-storage:/var/lib/storage"
    ];

    environment = {
      IMGPROXY_BIND                  = ":5001";
      IMGPROXY_LOCAL_FILESYSTEM_ROOT = "/";
      IMGPROXY_USE_ETAG              = "true";
      IMGPROXY_MAX_SRC_RESOLUTION    = "16.8";
    };

    environmentFiles = [ envFile ];

    extraOptions = [ (net "imgproxy") ];
  };

  # ── storage ───────────────────────────────────────────────────────
  # Storage API. Reads/writes files to /var/lib/storage (shared with
  # imgproxy), keeps metadata in Postgres (supabase_storage_admin
  # role). Listens on :5000.
  virtualisation.oci-containers.containers.supabase-storage = mkRootlessContainer {
    image = images.storage;
    dependsOn = [ "supabase-db" "supabase-rest" "supabase-imgproxy" ];

    volumes = [
      "/s2/supabase-storage:/var/lib/storage"
    ];

    environment = {
      POSTGREST_URL                  = "http://rest:3000";
      REQUEST_ALLOW_X_FORWARDED_PATH = "true";
      FILE_SIZE_LIMIT                = "52428800";
      STORAGE_BACKEND                = "file";
      FILE_STORAGE_BACKEND_PATH      = "/var/lib/storage";
      ENABLE_IMAGE_TRANSFORMATION    = "true";
      IMGPROXY_URL                   = "http://imgproxy:5001";
    };

    environmentFiles = [ envFile ];

    extraOptions = [ (net "storage") ];
  };

  # ── edge-functions (Deno) ─────────────────────────────────────────
  # Deno-based serverless functions. Reads function source from a
  # bind mount; ${hostRoot}/functions/main/index.ts is the default
  # entry point. Listens on :9000.
  virtualisation.oci-containers.containers.supabase-edge-functions = mkRootlessContainer {
    image = images.functions;
    dependsOn = [ "supabase-kong" ];

    volumes = [
      "${hostRoot}/functions:/home/deno/functions"
    ];

    environment = {
      SUPABASE_URL = "http://kong:8000";
    };

    environmentFiles = [ envFile ];

    # Upstream's command — invokes the edge-runtime binary directly.
    cmd = [
      "start"
      "--main-service" "/home/deno/functions/main"
    ];

    extraOptions = [ (net "functions") ];
  };

  # ── analytics (Logflare) ──────────────────────────────────────────
  # Stores logs in the _analytics schema of the same Postgres
  # cluster. Listens on :4000. Studio's Logs/Reports page reads from
  # here; Vector pushes to it (see below).
  virtualisation.oci-containers.containers.supabase-analytics = mkRootlessContainer {
    image = images.analytics;
    dependsOn = [ "supabase-db" ];

    environment = {
      LOGFLARE_NODE_HOST             = "127.0.0.1";
      DB_USERNAME                    = "supabase_admin";
      DB_DATABASE                    = "_supabase";
      DB_SCHEMA                      = "_analytics";
      LOGFLARE_SINGLE_TENANT         = "true";
      LOGFLARE_SUPABASE_MODE         = "true";
      POSTGRES_BACKEND_SCHEMA        = "_analytics";
      LOGFLARE_FEATURE_FLAG_OVERRIDE = "multibackend=true";
    };

    environmentFiles = [ envFile ];

    extraOptions = [ (net "analytics") ];
  };

  # ── vector (log shipper) ──────────────────────────────────────────
  # Reads container logs via the rootless podman user socket (mounted
  # as /var/run/docker.sock; the API is docker-compatible). Pushes
  # them to analytics. The container_name string is matched in
  # vector.yml's `router` step — we name the container supabase-vector
  # and our staged vector.yml has been patched accordingly (upstream
  # used `realtime-dev.supabase-realtime`; we use `supabase-realtime`).
  virtualisation.oci-containers.containers.supabase-vector = mkRootlessContainer {
    image = images.vector;
    dependsOn = [ "supabase-analytics" ];

    volumes = [
      "${hostRoot}/vector/vector.yml:/etc/vector/vector.yml:ro"
      # Rootless podman's user socket. linger=true + the
      # systemd.user.sockets.podman.wantedBy line above ensure it's
      # up before this container starts.
      "/run/user/1000/podman/podman.sock:/var/run/docker.sock:ro"
    ];

    environmentFiles = [ envFile ];

    cmd = [ "--config" "/etc/vector/vector.yml" ];

    extraOptions = [ (net "vector") ];
  };

  # ── pooler (Supavisor) ────────────────────────────────────────────
  # Connection pooler. Publishes :5432 (session-mode) and :6543
  # (transaction-mode) on the host. Internal metadata lives in the
  # _supabase database (supabase_admin role).
  #
  # The pooler.exs eval seeds tenant metadata on first boot — re-
  # running is idempotent.
  #
  # DATABASE_URL needs the `ecto://` scheme (not postgres://); we
  # alias from SUPAVISOR_DATABASE_URL in the env file.
  virtualisation.oci-containers.containers.supabase-pooler = mkRootlessContainer {
    image = images.pooler;
    dependsOn = [ "supabase-db" ];

    ports = [
      "5432:5432"
      "6543:6543"
    ];

    volumes = [
      "${hostRoot}/pooler/pooler.exs:/etc/pooler/pooler.exs:ro"
    ];

    environment = {
      PORT             = "4000";
      CLUSTER_POSTGRES = "true";
      REGION           = "local";
      POOLER_POOL_MODE = "transaction";
      ERL_AFLAGS       = "-proto_dist inet_tcp";
    };

    environmentFiles = [ envFile ];

    # Multi-step boot from upstream compose: migrate, seed-tenant,
    # then start the server. DATABASE_URL aliased from
    # SUPAVISOR_DATABASE_URL in the env file, since the image reads
    # DATABASE_URL but our canonical alias avoids colliding with the
    # storage container's postgres:// URL.
    entrypoint = "/bin/sh";
    cmd = [
      "-c"
      ''
        export DATABASE_URL="$SUPAVISOR_DATABASE_URL" && \
        /app/bin/migrate && \
        /app/bin/supavisor eval "$(cat /etc/pooler/pooler.exs)" && \
        exec /app/bin/server
      ''
    ];

    extraOptions = [ (net "pooler") ];
  };

  # ── kong (API gateway) ────────────────────────────────────────────
  # Declarative config loaded from kong.yml. The kong-entrypoint.sh
  # script substitutes ${ENV_VAR} placeholders into the YAML before
  # Kong starts (compose did this implicitly; we replicate it via the
  # bind-mounted entrypoint).
  #
  # `api-gw` alias is added because some Supabase clients still dial
  # `http://api-gw:8000` (compose called the network alias that).
  virtualisation.oci-containers.containers.supabase-kong = mkRootlessContainer {
    image = images.kong;
    dependsOn = [
      "supabase-auth"
      "supabase-rest"
      "supabase-realtime"
      "supabase-storage"
      "supabase-meta"
      "supabase-analytics"
    ];

    ports = [
      # Host 8000 is gluetun's; we publish Kong on 8400. Internal
      # listener stays :8000 (KONG_HTTP_PORT in env file).
      "8400:8000"
    ];

    volumes = [
      "${hostRoot}/kong/kong.yml:/home/kong/temp.yml:ro"
      "${hostRoot}/kong/kong-entrypoint.sh:/home/kong/kong-entrypoint.sh:ro"
    ];

    environment = {
      KONG_DATABASE                       = "off";
      KONG_DECLARATIVE_CONFIG             = "/usr/local/kong/kong.yml";
      # Order matters: A,CNAME first would loop on aardvark's
      # CNAME-then-A response; LAST,A,CNAME forces Kong to wait for
      # the final answer.
      KONG_DNS_ORDER                      = "LAST,A,CNAME";
      KONG_DNS_NOT_FOUND_TTL              = "1";
      KONG_PLUGINS                        = "request-transformer,cors,key-auth,acl,basic-auth,request-termination,ip-restriction,post-function";
      KONG_NGINX_PROXY_PROXY_BUFFER_SIZE  = "160k";
      KONG_NGINX_PROXY_PROXY_BUFFERS      = "64 160k";
      KONG_PROXY_ACCESS_LOG               = "/dev/stdout combined";
    };

    environmentFiles = [ envFile ];

    entrypoint = "/home/kong/kong-entrypoint.sh";

    extraOptions = [
      "--network=supabase-net:alias=kong,alias=api-gw"
    ];
  };

  # ── db-exporter (postgres_exporter for Prometheus) ────────────────
  # Scrapes pg_stat_* / pg_locks / etc. from supabase-db and exposes
  # them as Prometheus metrics on :9187. Host port 9188 (9187 is
  # already taken by nextcloud-exporter). Prometheus on monitoring-net
  # reaches it via host.containers.internal:9188 — same pattern as the
  # rest of the file-provider Traefik routes.
  #
  # Connects as supabase_admin (superuser) so it can read every stats
  # view including the pg_stat_statements extension. POSTGRES_PASSWORD
  # is aliased into the connection string by the entrypoint shell so
  # we don't duplicate the secret in the env file.
  virtualisation.oci-containers.containers.supabase-db-exporter = mkRootlessContainer {
    image = images.db-exporter;
    dependsOn = [ "supabase-db" ];

    ports = [
      "9188:9187"
    ];

    environmentFiles = [ envFile ];

    entrypoint = "/bin/sh";
    cmd = [
      "-c"
      ''
        export DATA_SOURCE_NAME="postgresql://supabase_admin:$POSTGRES_PASSWORD@db:5432/postgres?sslmode=disable" && \
        exec /bin/postgres_exporter
      ''
    ];

    extraOptions = [ (net "db-exporter") ];
  };

  # ── studio (Next.js dashboard) ────────────────────────────────────
  # The public-facing admin UI. Listens on :3000 internally;
  # published as host :3001 (3000 is grafana). Studio talks to Kong
  # for the API surface and to meta directly for table introspection.
  virtualisation.oci-containers.containers.supabase-studio = mkRootlessContainer {
    image = images.studio;
    dependsOn = [
      "supabase-kong"
      "supabase-meta"
      "supabase-analytics"
    ];

    ports = [
      # See traefikRoutes.supabase-studio above for port choice.
      "3003:3000"
    ];

    volumes = [
      "${hostRoot}/snippets:/app/snippets"
      "${hostRoot}/functions:/app/edge-functions"
    ];

    environment = {
      HOSTNAME                         = "0.0.0.0";
      STUDIO_PG_META_URL               = "http://meta:8080";
      SUPABASE_URL                     = "http://kong:8000";
      LOGFLARE_URL                     = "http://analytics:4000";
      NEXT_PUBLIC_ENABLE_LOGS          = "true";
      NEXT_ANALYTICS_BACKEND_PROVIDER  = "postgres";
      SNIPPETS_MANAGEMENT_FOLDER       = "/app/snippets";
      EDGE_FUNCTIONS_MANAGEMENT_FOLDER = "/app/edge-functions";
    };

    environmentFiles = [ envFile ];

    extraOptions = [ (net "studio") ];
  };
}
