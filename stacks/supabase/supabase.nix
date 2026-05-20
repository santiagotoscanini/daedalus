# supabase — multi-project wrapper.
#
# Each entry in `myStack.supabaseProjects` materializes one full
# Supabase stack: 14 containers on a dedicated bridge
# (`supabase-<id>-net`), data under `/home/santiago/selfhost/supabase/<id>/`,
# storage under `/s2/supabase-storage/<id>/`, env file at
# `/etc/nixos/stacks/supabase/secrets/<id>/env`, two Traefik routes with
# a per-project wildcard cert, two pi-hole DNS entries, two firewall
# ports for the LAN pooler, one Prometheus scrape (postgres-exporter
# sidecar), and one Grafana dashboard derived from the supabase
# dashboard template.
#
# By default `myStack.supabaseProjects` is empty — nothing comes up
# until a project is declared. See the bottom of CLAUDE.md for the
# bring-up recipe.
#
# What stays shared across projects:
#   - Image tags (the `images` attrset below — single source of truth
#     for an upstream version bump).
#   - The supabase- container-name prefix and the upstream bridge
#     alias short names (`db`, `meta`, `auth`,
#     `realtime-dev.supabase-realtime`, ...). The aliases are
#     bridge-scoped, so identical names across bridges do NOT collide
#     — and the env file's `POSTGRES_HOST=db`, kong.yml's
#     `http://rest:3000`, etc. all work unchanged.
#
# What's per-project (derived from `id`):
#   - URLs: `studio.<id>.supabase.toscanini.me`,
#           `kong.<id>.supabase.toscanini.me`
#   - Cert: `*.<id>.supabase.toscanini.me` (Traefik requests one
#     per project from the existing Cloudflare DNS-01 resolver)
#   - Container names: `supabase-<id>-<role>`
#   - Bridge: `supabase-<id>` → `podman-network-supabase-<id>-net.service`
#   - Storage tenant: `/s2/supabase-storage/<id>/`
#   - Env file: `/etc/nixos/stacks/supabase/secrets/<id>/env`
#   - Host paths under: `/home/santiago/selfhost/supabase/<id>/`
#   - Prometheus job_name: `supabase-<id>-db`
#   - Grafana dashboard: `supabase-<id>` (templated from
#     `stacks/supabase/assets/dashboard.json.in`)
#
# Per-project ports must be unique across projects on this host.
# Suggested allocation for the Nth project (N=0,1,2,…):
#   kong          = 8400 + N
#   studio        = 3003 + N
#   poolerSession = 5432 + N
#   poolerTx      = 6543 + N
#
# Why no custom entrypoints anywhere: docker-compose substitutes
# `${VAR}` into env var values at deploy time, so by the time the
# container starts, GOTRUE_JWT_SECRET / PGRST_DB_URI / etc. all hold
# their final string values. We do the same substitution at env-file-
# generation time. Every container then just reads
# `environmentFiles = [ envFile ]` and uses its image's default
# ENTRYPOINT/CMD.
#
# What's load-bearing per project (first-boot guarantees):
#   - `images.db` is load-bearing: the on-disk cluster in
#     ${hostRoot}/db/data is initdb'd by this image. Bumping the tag
#     without a pg_upgrade dance will fail.
#   - Init SQL files (mounted under /docker-entrypoint-initdb.d/...)
#     are load-bearing on FIRST BOOT only. They create the
#     supabase_admin / anon / authenticator / service_role roles and
#     the _supabase / _analytics / _realtime / _pooler schemas. If
#     the DB comes up with an empty data dir and these missing, the
#     cluster is unsalvageable — rm -rf db/data and rebuild.
#   - JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY in the env file are
#     cryptographically coupled. Rotating JWT_SECRET invalidates the
#     other two and every user JWT issued so far.

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  # Image tags — single source of truth. Tracks supabase/supabase
  # master's docker-compose.yml. Bumping each line here is the only
  # place an upgrade lives, and it applies to every project at once.
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

  rootBase = "/home/santiago/selfhost/supabase";
  envBase  = "/etc/nixos/stacks/supabase/secrets";

  # Dashboard template — one file with `%PROJECT_ID%` / `%DB_JOB%`
  # placeholders; `lib.replaceStrings` materializes a per-project
  # dashboard in `myStack.grafanaDashboards`.
  dashboardTemplate = builtins.readFile ./assets/dashboard.json.in;

  # Builds the NixOS module fragment for one project. NixOS's module
  # system merges across projects automatically — containerNetworks
  # (attrs union), tmpfiles.rules (list concat), firewall ports (list
  # concat), dnsHosts (list concat), prometheusScrapes (list concat),
  # grafanaDashboards (attrs union), traefikRoutes (attrs union),
  # virtualisation.oci-containers.containers (attrs union).
  mkProject = proj:
    let
      hostRoot   = "${rootBase}/${proj.id}";
      envFile    = "${envBase}/${proj.id}/env";
      dbInit     = "${hostRoot}/db-init";
      bridge     = "supabase-${proj.id}";
      cName      = role: "supabase-${proj.id}-${role}";
      net        = alias: "--network=${bridge}-net:alias=${alias}";
      studioHost = "supabase-studio-${proj.id}.toscanini.me";
      kongHost   = "supabase-kong-${proj.id}.toscanini.me";
    in {
      myStack.containerNetworks = lib.listToAttrs (map
        (role: lib.nameValuePair (cName role) bridge)
        [ "db" "db-exporter" "meta" "auth" "rest" "realtime"
          "imgproxy" "storage" "edge-functions" "analytics"
          "vector" "pooler" "kong" "studio" ]);

      # Two public-facing routes (studio + kong) — both single-level
      # subdomains of toscanini.me, so the entrypoint-level wildcard
      # cert covers them with no per-route ACME work. Internal API
      # services (auth/rest/realtime/etc.) are reached only through
      # Kong, so they have no Traefik routes.
      myStack.webApps."${cName "studio"}" = {
        hostname = studioHost;
        port     = proj.ports.studio;
      };
      myStack.webApps."${cName "kong"}" = {
        hostname = kongHost;
        port     = proj.ports.kong;
      };

      # LAN psql access through Supavisor. The pi-hole-served DHCP
      # scope plus everyone-on-the-LAN psql access is fine for our
      # threat model; rotate POSTGRES_PASSWORD if anything sensitive
      # lands in the DB and we ever expose it more widely.
      networking.firewall.allowedTCPPorts = [
        proj.ports.poolerSession
        proj.ports.poolerTx
      ];

      # postgres-exporter scrape — one job per project, distinguished
      # by job_name `supabase-<id>-db` and a `project` label.
      myStack.prometheusScrapes = [ {
        job_name = "supabase-${proj.id}-db";
        static_configs = [ {
          targets = [ "${cName "db-exporter"}:9187" ];
          labels  = { project = proj.id; };
        } ];
      } ];

      # Per-project dashboard, templated from the .json.in file.
      myStack.grafanaDashboardsByFolder."Supabase"."supabase-${proj.id}" =
        lib.replaceStrings
          [ "%PROJECT_ID%" "%DB_JOB%" ]
          [ proj.id "supabase-${proj.id}-db" ]
          dashboardTemplate;

      # Backend group tiles — one Studio + one Kong link per project.
      # No upstream homepage widget exists for Supabase, so these are
      # link tiles with siteMonitor pings against the host ports.
      myStack.homepageServices."Backend" = [
        {
          name = "Supabase Studio (${proj.id})";
          href = "https://${studioHost}";
          description = "Postgres + Auth + Realtime + Storage admin UI (${proj.id})";
          icon = "supabase.png";
          siteMonitor = "http://host.containers.internal:${toString proj.ports.studio}";
        }
        {
          name = "Supabase API (${proj.id})";
          href = "https://${kongHost}";
          description = "Kong gateway — /auth, /rest, /realtime, /storage, /functions (${proj.id})";
          icon = "mdi-api-#34d399";
          siteMonitor = "http://host.containers.internal:${toString proj.ports.kong}";
        }
      ];

      # systemd-tmpfiles creates bind-mount target dirs at activation
      # with the right rootless-podman UID mapping. The
      # supabase/postgres image runs as container UID 105
      # (Debian-style), which maps to host 100104 (= 99999 + 105) in
      # santiago's subuid range. systemd-tmpfiles re-enforces
      # ownership on every nixos-rebuild — bumping the image to an
      # Alpine variant (UID 70 → 100069) would also require editing
      # those two lines here.
      systemd.tmpfiles.rules = [
        "d ${hostRoot}                       0755 santiago users  -"
        "d ${hostRoot}/db                    0755 santiago users  -"
        "d ${hostRoot}/db/data               0700 100104   100105 -"
        "d ${hostRoot}/db-config             0700 100104   100105 -"
        # Per-project storage tenant. The storage container's volume
        # below mounts this at /var/lib/storage/${proj.id}, so writes
        # land here on the s2-pool HDD mirror.
        "d /s2/supabase-storage/${proj.id}   0755 santiago users  -"
        "d ${hostRoot}/snippets              0755 santiago users  -"
        "d ${hostRoot}/studio                0755 santiago users  -"
        "d ${hostRoot}/functions             0755 santiago users  -"
        "d ${hostRoot}/functions/main        0755 santiago users  -"
        "d ${hostRoot}/logs                  0755 santiago users  -"
      ];

      # Seeds /etc/postgresql-custom on first boot from the image's
      # own /etc/postgresql-custom — supautils.conf, wal-g.conf,
      # read-replica.conf. Idempotent: skips if the bind-target is
      # already populated. Replaces what `podman volume create` auto-
      # populating from the image would have done for a named volume.
      # First-boot bootstrap: generate env file with fresh secrets and
      # seed static configs from /nix/store-baked
      # /etc/nixos/stacks/supabase/assets. Idempotent — every file/dir
      # is skipped if already present.
      systemd.services."supabase-${proj.id}-bootstrap" = {
        description = "Bootstrap supabase ${proj.id}: env file + static configs on first boot";
        after = [ "local-fs.target" ];
        before = (map (r: "podman-${cName r}.service") [
          "db" "db-exporter" "meta" "auth" "rest" "realtime" "imgproxy"
          "storage" "edge-functions" "analytics" "vector" "pooler" "kong" "studio"
        ]) ++ [ "supabase-${proj.id}-db-config-seed.service" ];
        wantedBy = [ "podman-${cName "db"}.service" ];
        environment = {
          PROJECT_ID  = proj.id;
          HOST_ROOT   = hostRoot;
          STATIC_DIR  = "${./assets}";
          STUDIO_HOST = studioHost;
          KONG_HOST   = kongHost;
          ENV_FILE    = envFile;
          PATH        = lib.mkForce (lib.makeBinPath [
            pkgs.bash pkgs.openssl pkgs.coreutils pkgs.gnused
          ]);
        };
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          Restart = "on-failure";
          RestartSec = "5s";
          ExecStart = "${pkgs.bash}/bin/bash ${./assets}/bootstrap.sh";
        };
      };

      systemd.services."supabase-${proj.id}-db-config-seed" = {
        description = "Seed supabase ${proj.id} /etc/postgresql-custom bind mount on first boot";
        after = [ "network-online.target" "local-fs.target" ];
        wants = [ "network-online.target" ];
        before = [ "podman-${cName "db"}.service" ];
        wantedBy = [ "podman-${cName "db"}.service" ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          User = "santiago";
          Environment = "XDG_RUNTIME_DIR=/run/user/1000";
          Restart = "on-failure";
          RestartSec = "10s";
          ExecStart = pkgs.writeShellScript "supabase-${proj.id}-db-config-seed" ''
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

      # The auto-emitted podman unit override (modules/common.nix) only
      # adds an `after` dep on the PRIMARY bridge unit (supabase-<id>-net).
      # Since this container also attaches to monitoring-net (so
      # Prometheus can scrape by container name), declare that dep too,
      # else the unit can race ahead of the monitoring bridge.
      systemd.services."podman-${cName "db-exporter"}" = {
        after = [ "podman-network-monitoring-net.service" ];
        wants = [ "podman-network-monitoring-net.service" ];
      };

      virtualisation.oci-containers.containers = {

        # ── db ──────────────────────────────────────────────────────
        # Custom supabase/postgres image: stock Postgres 15 + pgsodium,
        # pg_jwt, pg_cron, vault, plv8, supautils, etc. Do NOT swap for
        # docker.io/library/postgres:15-alpine — the schemas Supabase
        # creates at init time require these extensions.
        #
        # POSTGRES_HOST inside this container is a Unix socket. The
        # env file exposes POSTGRES_HOST=db (the bridge alias) for the
        # OTHER containers; the explicit `environment` block here
        # overrides that for db itself. Without this override,
        # pg_isready and the init scripts try to dial `db:5432` and
        # fail because the listener isn't ready yet during init.
        "${cName "db"}" = mkRootlessContainer {
          image = images.db;

          volumes = [
            "${hostRoot}/db/data:/var/lib/postgresql/data"
            "${hostRoot}/db-config:/etc/postgresql-custom"
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
            "-c" "log_min_messages=fatal"
          ];

          extraOptions = [ (net "db") ];
        };

        # ── meta ────────────────────────────────────────────────────
        # postgres-meta — DB introspection API consumed by Studio's
        # table editor. Listens on :8080 internally; reached as
        # `meta:8080` from Kong + Studio.
        "${cName "meta"}" = mkRootlessContainer {
          image = images.meta;
          dependsOn = [ (cName "db") ];

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

        # ── auth (GoTrue) ───────────────────────────────────────────
        # GoTrue auth server. Listens on :9999. Reads its config from
        # GOTRUE_* env vars baked into the env file at generation time.
        "${cName "auth"}" = mkRootlessContainer {
          image = images.auth;
          dependsOn = [ (cName "db") ];

          environment = {
            GOTRUE_API_HOST               = "0.0.0.0";
            GOTRUE_API_PORT               = "9999";
            GOTRUE_DB_DRIVER              = "postgres";
            GOTRUE_JWT_ADMIN_ROLES        = "service_role";
            GOTRUE_JWT_AUD                = "authenticated";
            GOTRUE_JWT_DEFAULT_GROUP_NAME = "authenticated";
            API_EXTERNAL_URL              = "https://${kongHost}";
          };

          environmentFiles = [ envFile ];

          extraOptions = [ (net "auth") ];
        };

        # ── rest (PostgREST) ────────────────────────────────────────
        # PostgREST. Listens on :3000. Reached as `rest:3000` from
        # Kong. Connects as `authenticator`; PostgREST sets the role
        # per-request based on the JWT.
        "${cName "rest"}" = mkRootlessContainer {
          image = images.rest;
          dependsOn = [ (cName "db") ];

          environment = {
            PGRST_DB_ANON_ROLE       = "anon";
            PGRST_DB_USE_LEGACY_GUCS = "false";
          };

          environmentFiles = [ envFile ];

          cmd = [ "postgrest" ];

          extraOptions = [ (net "rest") ];
        };

        # ── realtime ────────────────────────────────────────────────
        # Phoenix-based WebSocket service. Listens on :4000. Kong
        # dials it at `realtime-dev.supabase-realtime:4000` — that
        # hostname is load-bearing because realtime extracts the
        # tenant ID from the subdomain portion (`realtime-dev`). We
        # use a bridge alias rather than naming the container with a
        # dot (cleaner nix attribute).
        "${cName "realtime"}" = mkRootlessContainer {
          image = images.realtime;
          dependsOn = [ (cName "db") ];

          environment = {
            PORT                        = "4000";
            DB_USER                     = "supabase_admin";
            DB_AFTER_CONNECT_QUERY      = "SET search_path TO _realtime";
            DB_ENC_KEY                  = "supabaserealtime";  # 16 chars — AES-128
            ERL_AFLAGS                  = "-proto_dist inet_tcp";
            DNS_NODES                   = "''";
            RLIMIT_NOFILE               = "10000";
            APP_NAME                    = "realtime";
            SEED_SELF_HOST              = "true";
            RUN_JANITOR                 = "true";
            DISABLE_HEALTHCHECK_LOGGING = "true";
          };

          environmentFiles = [ envFile ];

          extraOptions = [ (net "realtime-dev.supabase-realtime") ];
        };

        # ── imgproxy ────────────────────────────────────────────────
        # Image transformer. No DB. Shares the per-project storage
        # bind mount with the storage container so it can
        # transform-and-serve images by file path. The mount path
        # inside the container matches the path Supabase storage
        # writes to (under `/var/lib/storage/<GLOBAL_S3_BUCKET>/...`),
        # because GLOBAL_S3_BUCKET in the env file equals the project
        # id and so does the bind-mount segment.
        "${cName "imgproxy"}" = mkRootlessContainer {
          image = images.imgproxy;

          volumes = [
            "/s2/supabase-storage/${proj.id}:/var/lib/storage/${proj.id}"
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

        # ── storage ─────────────────────────────────────────────────
        # Storage API. Reads/writes files to /var/lib/storage (shared
        # with imgproxy), keeps metadata in Postgres
        # (supabase_storage_admin role). Listens on :5000.
        "${cName "storage"}" = mkRootlessContainer {
          image = images.storage;
          dependsOn = [ (cName "db") (cName "rest") (cName "imgproxy") ];

          volumes = [
            "/s2/supabase-storage/${proj.id}:/var/lib/storage/${proj.id}"
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

        # ── edge-functions (Deno) ──────────────────────────────────
        # Deno-based serverless functions. Reads function source from
        # a bind mount; ${hostRoot}/functions/main/index.ts is the
        # default entry point. Listens on :9000.
        "${cName "edge-functions"}" = mkRootlessContainer {
          image = images.functions;
          dependsOn = [ (cName "kong") ];

          volumes = [
            "${hostRoot}/functions:/home/deno/functions"
          ];

          environment = {
            SUPABASE_URL = "http://kong:8000";
          };

          environmentFiles = [ envFile ];

          cmd = [
            "start"
            "--main-service" "/home/deno/functions/main"
          ];

          extraOptions = [ (net "functions") ];
        };

        # ── analytics (Logflare) ────────────────────────────────────
        # Stores logs in the _analytics schema of the same Postgres
        # cluster. Listens on :4000. Studio's Logs/Reports page reads
        # from here; Vector pushes to it.
        "${cName "analytics"}" = mkRootlessContainer {
          image = images.analytics;
          dependsOn = [ (cName "db") ];

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

        # ── vector (log shipper) ────────────────────────────────────
        # Reads container logs via the rootless podman user socket
        # (mounted as /var/run/docker.sock; the API is
        # docker-compatible). Pushes them to analytics. The
        # vector.yml's `router` step matches container names — note
        # the per-project container names need to match what
        # vector.yml expects (copy from upstream and adjust during
        # bring-up).
        "${cName "vector"}" = mkRootlessContainer {
          image = images.vector;
          dependsOn = [ (cName "analytics") ];

          volumes = [
            "${hostRoot}/vector/vector.yml:/etc/vector/vector.yml:ro"
            "/run/user/1000/podman/podman.sock:/var/run/docker.sock:ro"
          ];

          environmentFiles = [ envFile ];

          cmd = [ "--config" "/etc/vector/vector.yml" ];

          extraOptions = [ (net "vector") ];
        };

        # ── pooler (Supavisor) ──────────────────────────────────────
        # Connection pooler. Publishes session-mode and transaction-
        # mode ports on the host (per-project — see proj.ports above).
        # Internal metadata lives in the _supabase database
        # (supabase_admin role).
        #
        # DATABASE_URL needs the `ecto://` scheme (not postgres://);
        # we alias from SUPAVISOR_DATABASE_URL in the env file.
        "${cName "pooler"}" = mkRootlessContainer {
          image = images.pooler;
          dependsOn = [ (cName "db") ];

          ports = [
            "${toString proj.ports.poolerSession}:5432"
            "${toString proj.ports.poolerTx}:6543"
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

        # ── kong (API gateway) ──────────────────────────────────────
        # Declarative config loaded from kong.yml. The
        # kong-entrypoint.sh script substitutes ${ENV_VAR}
        # placeholders into the YAML before Kong starts.
        #
        # `api-gw` alias is added because some Supabase clients still
        # dial `http://api-gw:8000` (compose called the network alias
        # that). Both aliases live on the same per-project bridge.
        "${cName "kong"}" = mkRootlessContainer {
          image = images.kong;
          dependsOn = [
            (cName "auth")
            (cName "rest")
            (cName "realtime")
            (cName "storage")
            (cName "meta")
            (cName "analytics")
          ];

          ports = [
            "${toString proj.ports.kong}:8000"
          ];

          volumes = [
            "${hostRoot}/kong/kong.yml:/home/kong/temp.yml:ro"
            "${hostRoot}/kong/kong-entrypoint.sh:/home/kong/kong-entrypoint.sh:ro"
          ];

          environment = {
            KONG_DATABASE                       = "off";
            KONG_DECLARATIVE_CONFIG             = "/usr/local/kong/kong.yml";
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
            "--network=${bridge}-net:alias=kong,alias=api-gw"
          ];
        };

        # ── db-exporter (postgres_exporter for Prometheus) ──────────
        # Scrapes pg_stat_* / pg_locks / etc. from supabase-db and
        # exposes them as Prometheus metrics on :9187 (internal).
        # Scraped by Prometheus over monitoring-net (multi-bridge attach
        # below). Connects as
        # supabase_admin (superuser) so it can read every stats view
        # including pg_stat_statements.
        "${cName "db-exporter"}" = mkRootlessContainer {
          image = images.db-exporter;
          dependsOn = [ (cName "db") ];


          environmentFiles = [ envFile ];

          entrypoint = "/bin/sh";
          cmd = [
            "-c"
            ''
              export DATA_SOURCE_NAME="postgresql://supabase_admin:$POSTGRES_PASSWORD@db:5432/postgres?sslmode=disable" && \
              exec /bin/postgres_exporter
            ''
          ];

          extraOptions = [ (net "db-exporter") "--network=monitoring-net" ];
        };

        # ── studio (Next.js dashboard) ──────────────────────────────
        # The public-facing admin UI. Listens on :3000 internally;
        # published as `proj.ports.studio`. Studio talks to Kong for
        # the API surface and to meta directly for table
        # introspection.
        "${cName "studio"}" = mkRootlessContainer {
          image = images.studio;
          dependsOn = [
            (cName "kong")
            (cName "meta")
            (cName "analytics")
          ];

          ports = [
            "${toString proj.ports.studio}:3000"
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
      };
    };
in
{
  options.myStack.supabaseProjects = lib.mkOption {
    type = lib.types.attrsOf (lib.types.submodule ({ ... }: {
      options = {
        id = lib.mkOption {
          type = lib.types.str;
          description = ''
            Project identifier — used as: container-name suffix
            (`supabase-<id>-*`), bridge suffix
            (`podman-network-supabase-<id>-net.service`), URL segment
            (`studio.<id>.supabase.toscanini.me`), host-path
            subdir (`/home/santiago/selfhost/supabase/<id>/`), env
            subdir (`/etc/nixos/stacks/supabase/secrets/<id>/env`), and
            storage tenant (`/s2/supabase-storage/<id>/`).

            Must equal `GLOBAL_S3_BUCKET` in the project's env file
            (the storage container constructs in-container paths from
            that env var).
          '';
        };
        ports = lib.mkOption {
          type = lib.types.submodule ({ ... }: {
            options = {
              kong = lib.mkOption {
                type = lib.types.port;
                description = "Host port for Kong (internal 8000).";
              };
              studio = lib.mkOption {
                type = lib.types.port;
                description = "Host port for Studio (internal 3000).";
              };
              poolerSession = lib.mkOption {
                type = lib.types.port;
                description = "Host port for Supavisor session mode (internal 5432).";
              };
              poolerTx = lib.mkOption {
                type = lib.types.port;
                description = "Host port for Supavisor transaction mode (internal 6543).";
              };
            };
          });
          description = ''
            Host-side port allocation. Must not collide with any
            other project on this host or with other stacks.
            Suggested allocation for the Nth project (N=0,1,2,…):
              kong          = 8400 + N
              studio        = 3003 + N
              poolerSession = 5432 + N
              poolerTx      = 6543 + N
          '';
        };
      };
    }));
    default = { };
    description = ''
      Per-project Supabase stacks. Each entry materializes 14
      containers, two Traefik routes with a per-project wildcard
      cert, the bridge, pi-hole DNS entries, firewall ports, a
      Prometheus scrape, and a Grafana dashboard. See the module
      header comment for the full list of derived names and paths.
    '';
  };

  config = let
    projects  = lib.attrValues config.myStack.supabaseProjects;
    fragments = map mkProject projects;
    # Helpers — extract per-option contributions from each fragment
    # and combine them with the option's natural merge semantics.
    # The top-level config attrset has STATIC keys (NixOS can compute
    # freeformType without iterating projects); each value uses
    # `mkMerge`/`concatLists` to fold the dynamic per-project list.
    attrsOpt = path: lib.mkMerge   (map (f: lib.attrByPath path { } f) fragments);
    listOpt  = path: lib.concatLists (map (f: lib.attrByPath path [ ] f) fragments);
  in {
    # Vector talks to rootless podman over its user socket.
    # linger=true for santiago in configuration.nix already keeps
    # user@1000.service up at boot; this wantedBy makes the user
    # socket itself auto-start. Shared by every project.
    systemd.user.sockets.podman.wantedBy = [ "sockets.target" ];

    virtualisation.oci-containers.containers =
      attrsOpt [ "virtualisation" "oci-containers" "containers" ];

    myStack = {
      containerNetworks = attrsOpt [ "myStack" "containerNetworks" ];
      traefikRoutes     = attrsOpt [ "myStack" "traefikRoutes" ];
      webApps           = attrsOpt [ "myStack" "webApps" ];
      dnsHosts          = listOpt  [ "myStack" "dnsHosts" ];
      prometheusScrapes = listOpt  [ "myStack" "prometheusScrapes" ];
      grafanaDashboards = attrsOpt [ "myStack" "grafanaDashboards" ];
      grafanaDashboardsByFolder = attrsOpt [ "myStack" "grafanaDashboardsByFolder" ];
      homepageServices  = attrsOpt [ "myStack" "homepageServices" ];
    };

    networking.firewall.allowedTCPPorts =
      listOpt [ "networking" "firewall" "allowedTCPPorts" ];

    systemd.tmpfiles.rules = listOpt [ "systemd" "tmpfiles" "rules" ];

    systemd.services = attrsOpt [ "systemd" "services" ];
  };
}
