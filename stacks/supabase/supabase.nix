# supabase — multi-project wrapper.
#
# Each entry in `myStack.supabaseProjects` materializes a full Supabase
# stack: 14 containers on `supabase-<id>-net`, data under
# /home/santiago/selfhost/supabase/<id>/, storage under
# /s2/supabase-storage/<id>/, env at stacks/supabase/secrets/<id>/env,
# two Traefik routes, two pi-hole DNS entries, two firewall ports for
# the LAN pooler, one Prometheus scrape, one Grafana dashboard.
#
# Per-project derived names (from `id`):
#   URLs    : studio.<id>.supabase.toscanini.me / kong.<id>.supabase.toscanini.me
#   Cert    : *.<id>.supabase.toscanini.me (per-project wildcard)
#   Containers: supabase-<id>-<role>
#   Bridge  : supabase-<id>-net
#   Storage : /s2/supabase-storage/<id>/
#   Paths   : /home/santiago/selfhost/supabase/<id>/
#   Env     : /etc/nixos/stacks/supabase/secrets/<id>/env
#   Metrics : job_name supabase-<id>-db, dashboard supabase-<id>
#
# Per-project host ports — only the two poolers (PostgreSQL wire
# protocol; external psql clients dial directly, no Host-header
# equivalent for hostname-based routing). kong + studio bridge-route
# via traefik-net (`serviceName = supabase-<id>-{kong,studio}`).
# Allocation collapses to one integer per project (`slot`):
#   poolerSession = 5432 + slot
#   poolerTx      = 6543 + slot
#
# Load-bearing first-boot guarantees:
#   - images.db: the on-disk cluster is initdb'd by this image; bumping
#     the tag without a pg_upgrade dance will fail.
#   - Init SQL files (db-init/*.sql) are FIRST-BOOT-ONLY. They create
#     the supabase_admin / anon / authenticator / service_role roles
#     and the _supabase / _analytics / _realtime / _pooler schemas.
#     If the DB initdb's with these missing the cluster is unsalvageable
#     (rm -rf db/data + rebuild).
#   - JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY in env are cryptographically
#     coupled; rotating JWT_SECRET invalidates the other two and every
#     user JWT issued so far.
#
# Why no custom entrypoints: bootstrap.sh substitutes ${VAR} into env
# values at file-generation time (same as docker-compose at deploy
# time), so containers just read environmentFiles and use the image's
# default ENTRYPOINT/CMD.

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  # Image tags — single source of truth, tracks supabase/supabase
  # master's docker-compose.yml. Bumping here applies to every project.
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

  # Dashboard template with %PROJECT_ID% / %DB_JOB% placeholders;
  # lib.replaceStrings materializes one per project.
  dashboardTemplate = builtins.readFile ./assets/dashboard.json.in;

  # Per-project NixOS module fragment. NixOS module-system merging
  # combines fragments at the top-level config attrset below.
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
      poolerSessionPort = 5432 + proj.slot;
      poolerTxPort      = 6543 + proj.slot;
      capitalize = s:
        (lib.toUpper (lib.substring 0 1 s))
        + (lib.substring 1 (lib.stringLength s) s);
      tileGroup  = capitalize proj.id;
    in {
      myStack.containerNetworks = lib.listToAttrs (map
        (role: lib.nameValuePair (cName role) bridge)
        [ "db" "db-exporter" "meta" "auth" "rest" "realtime"
          "imgproxy" "storage" "edge-functions" "analytics"
          "vector" "pooler" "kong" "studio" ]);

      # Two public-facing routes (studio + kong). Internal API services
      # (auth/rest/realtime/etc.) are reached only through Kong and have
      # no traefik routes of their own.
      myStack.webApps."${cName "studio"}" = {
        hostname    = studioHost;
        serviceName = cName "studio";
        port        = 3000;
      };
      myStack.webApps."${cName "kong"}" = {
        hostname    = kongHost;
        serviceName = cName "kong";
        port        = 8000;
      };

      # LAN psql via Supavisor — anyone on the LAN can dial these
      # ports. Rotate POSTGRES_PASSWORD if anything sensitive lands
      # in the DB and exposure widens.
      networking.firewall.allowedTCPPorts = [
        poolerSessionPort
        poolerTxPort
      ];

      myStack.prometheusScrapes = [ {
        job_name = "supabase-${proj.id}-db";
        static_configs = [ {
          targets = [ "${cName "db-exporter"}:9187" ];
          labels  = { project = proj.id; };
        } ];
      } ];

      myStack.grafanaDashboardsByFolder."Supabase"."supabase-${proj.id}" =
        lib.replaceStrings
          [ "%PROJECT_ID%" "%DB_JOB%" ]
          [ proj.id "supabase-${proj.id}-db" ]
          dashboardTemplate;

      myStack.homepageServices."${tileGroup}" = [
        {
          name = "Studio";
          href = "https://${studioHost}";
          description = "Postgres + Auth + Realtime + Storage admin UI";
          icon = "supabase.png";
          siteMonitor = "http://${cName "studio"}:3000";
        }
        {
          name = "API";
          href = "https://${kongHost}";
          description = "Kong gateway — /auth, /rest, /realtime, /storage, /functions";
          icon = "mdi-api-#34d399";
          siteMonitor = "http://${cName "kong"}:8000";
        }
      ];

      # systemd-tmpfiles re-enforces ownership every rebuild. Container
      # UID 105 (supabase/postgres, Debian) → host 100104 in santiago's
      # subuid range. Alpine variant (UID 70 → 100069) would need both
      # 100104 lines edited.
      systemd.tmpfiles.rules = [
        "d ${hostRoot}                       0755 santiago users  -"
        "d ${hostRoot}/db                    0755 santiago users  -"
        "d ${hostRoot}/db/data               0700 100104   100105 -"
        "d ${hostRoot}/db-config             0700 100104   100105 -"
        "d /s2/supabase-storage/${proj.id}   0755 santiago users  -"
        "d ${hostRoot}/snippets              0755 santiago users  -"
        "d ${hostRoot}/studio                0755 santiago users  -"
        "d ${hostRoot}/functions             0755 santiago users  -"
        "d ${hostRoot}/functions/main        0755 santiago users  -"
        "d ${hostRoot}/logs                  0755 santiago users  -"
      ];

      # First-boot bootstrap: generate env file with fresh secrets and
      # seed static configs from /nix/store. Idempotent — every file is
      # skipped if already present.
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

      # Seeds /etc/postgresql-custom (supautils.conf, wal-g.conf,
      # read-replica.conf) on first boot from the image. Replaces what
      # a podman named volume would auto-populate. Idempotent.
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

      # common.nix's auto-emitted override only adds an `after` dep on
      # the PRIMARY bridge unit. db-exporter also attaches to
      # monitoring-net, so declare that dep explicitly.
      systemd.services."podman-${cName "db-exporter"}" = {
        after = [ "podman-network-monitoring-net.service" ];
        wants = [ "podman-network-monitoring-net.service" ];
      };

      virtualisation.oci-containers.containers = {

        # ── db ────────────────────────────────────────────────
        # Custom supabase/postgres image (PG 15 + pgsodium, pg_jwt,
        # pg_cron, vault, plv8, supautils). Do NOT swap for upstream
        # postgres — schemas Supabase creates require these extensions.
        # Override POSTGRES_HOST to a Unix socket here (env file sets
        # the bridge alias `db` for OTHER containers); otherwise the
        # init scripts try to dial `db:5432` before the listener's ready.
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

        # ── meta ──────────────────────────────────────────────
        # postgres-meta — DB introspection HTTP API for Studio's table
        # editor. Reached as `meta:8080` from Kong + Studio.
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

        # ── auth (GoTrue) ─────────────────────────────────────
        # JWT issuing + OAuth. Config in GOTRUE_* env vars baked at
        # env-file generation time.
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

        # ── rest (PostgREST) ──────────────────────────────────
        # Connects as `authenticator`; PostgREST sets the postgres role
        # per-request based on the JWT. Reached as `rest:3000` by Kong.
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

        # ── realtime ─────────────────────────────────────────
        # Phoenix WebSocket service. Bridge alias
        # `realtime-dev.supabase-realtime` is LOAD-BEARING — realtime
        # extracts the tenant ID from the leftmost label (`realtime-dev`),
        # and Kong dials it by that hostname. Using an alias (rather
        # than naming the container with a dot) keeps the nix attribute clean.
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

        # ── imgproxy ─────────────────────────────────────────
        # Image transformer. Shares the per-project storage bind with
        # `storage` so it can serve transforms by file path.
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

        # ── storage ──────────────────────────────────────────
        # File upload API. Blobs on disk (shared with imgproxy),
        # metadata in Postgres (supabase_storage_admin role).
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

        # ── edge-functions (Deno) ────────────────────────────
        # Deno serverless runtime. Reads source from ${hostRoot}/
        # functions/main/index.ts (the default entry point).
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

        # ── analytics (Logflare) ─────────────────────────────
        # Single-tenant Logflare backed by the same Postgres cluster
        # (`_analytics` schema). Studio's Logs page reads from here;
        # Vector pushes to it.
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

        # ── vector (log shipper) ─────────────────────────────
        # Reads container logs via the rootless podman socket
        # (docker-compatible API), routes them to analytics. Per-project
        # container names must match what vector.yml's `router` step
        # expects — copy upstream and adjust during bring-up.
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

        # ── pooler (Supavisor) ───────────────────────────────
        # Connection pooler. Publishes session + transaction-mode ports
        # on the host (poolerSessionPort + poolerTxPort). DATABASE_URL
        # needs the `ecto://` scheme; aliased from SUPAVISOR_DATABASE_URL
        # in the env file.
        "${cName "pooler"}" = mkRootlessContainer {
          image = images.pooler;
          dependsOn = [ (cName "db") ];

          ports = [
            "${toString poolerSessionPort}:5432"
            "${toString poolerTxPort}:6543"
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

        # ── kong (API gateway) ───────────────────────────────
        # Declarative config from kong.yml; kong-entrypoint.sh
        # substitutes ${ENV_VAR} placeholders before kong starts.
        # `api-gw` alias kept for compose-era clients that dial
        # `http://api-gw:8000`. Joins traefik-net as secondary so
        # traefik reaches it by container DNS, no host port.
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
            "--network=traefik-net"
          ];
        };

        # ── db-exporter (postgres_exporter) ──────────────────
        # Scrapes pg_stat_* / pg_locks / etc. on :9187 (internal).
        # Connects as supabase_admin (superuser) so it can read every
        # stats view including pg_stat_statements. Multi-bridge to be
        # reachable from Prometheus on monitoring-net.
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

        # ── studio (Next.js dashboard) ───────────────────────
        # The public admin UI. Talks to Kong for the API surface and
        # to meta directly for table introspection.
        "${cName "studio"}" = mkRootlessContainer {
          image = images.studio;
          dependsOn = [
            (cName "kong")
            (cName "meta")
            (cName "analytics")
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

          extraOptions = [
            (net "studio")
            "--network=traefik-net"
          ];
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
            Project identifier — used as container-name suffix
            (`supabase-<id>-*`), bridge suffix, URL segment, host-path
            subdir, env subdir, and storage tenant. Must equal
            `GLOBAL_S3_BUCKET` in the project env file (storage
            container builds in-container paths from that).
          '';
        };
        slot = lib.mkOption {
          type = lib.types.ints.unsigned;
          description = ''
            Project slot index, unique across projects on this host.
            Derives the two host-published pooler ports:
              poolerSession = 5432 + slot
              poolerTx      = 6543 + slot
            Kong + Studio are bridge-routed on traefik-net — no host port.
          '';
          example = 0;
        };
      };
    }));
    default = { };
    description = ''
      Per-project Supabase stacks — see the module header for what
      each entry materializes and which names/paths derive from `id`.
    '';
  };

  config = let
    projects  = lib.attrValues config.myStack.supabaseProjects;
    fragments = map mkProject projects;
    # Combine per-option contributions from each fragment using each
    # option's natural merge semantics. Top-level keys are static so
    # NixOS can compute freeformType without iterating projects.
    attrsOpt = path: lib.mkMerge   (map (f: lib.attrByPath path { } f) fragments);
    listOpt  = path: lib.concatLists (map (f: lib.attrByPath path [ ] f) fragments);
  in {
    # Vector talks to rootless podman over the user socket. linger=true
    # in configuration.nix keeps user@1000 up; this makes the socket
    # itself auto-start. Shared by every project.
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
