# app-db — single shared Postgres cluster, one database per app.
#
# Activated when `myStack.appDatabases` is non-empty (declaring an
# entry IS the enable signal). Materializes:
#
#   - One `pg` container (`postgres:18.4-alpine`) on the shared
#     `app-db-net` bridge. Data at /home/santiago/selfhost/app-db/postgres,
#     owner 100069:100069 (in-container UID 70 = postgres mapped via
#     santiago's subuid range).
#   - `pg-cluster-bootstrap.service` — one-time, generates the cluster
#     superuser POSTGRES_PASSWORD into
#     /etc/nixos/stacks/app-db/secrets/cluster/env.
#   - Per app, `app-db-<name>-bootstrap.service` — runs idempotent SQL
#     against `pg` to materialize the per-app role + database, then
#     writes /etc/nixos/stacks/app-db/secrets/<name>/env with the per-app
#     DATABASE_URL (postgresql://<name>:<pwd>@pg:5432/<name>).
#
# Isolation:
#   - Per-app role owns its database.
#   - `REVOKE ALL ON DATABASE <name> FROM PUBLIC` so other roles can't
#     even connect.
#   - `ALTER ROLE` keeps role passwords in sync with the env file
#     (rotation = delete the env file + rebuild).
#
# Per-app resource limits:
#   - Connection cap via `ALTER ROLE <name> CONNECTION LIMIT N` if
#     needed (default: cluster-wide max_connections shared).
#   - statement_timeout / lock_timeout per-role via ALTER ROLE.
#   - For full container-level isolation, switch that app to a
#     dedicated container — escape hatch, not implemented yet.
#
# Tuning (shared cluster — sized for ~10 hobby apps):
#   shared_buffers       = 256MB
#   max_connections      = 200
#   work_mem             = 8MB
#   maintenance_work_mem = 64MB
#   effective_cache_size = 1GB
#
# Container caps: cpus=2, memory=2g, pids-limit=500.
#
# TODO: front this with PgBouncer (transaction pooling) when
# pg_stat_activity connection counts approach max_connections=200
# (~15 tenants today, each opening ORM-style pools of 10–25
# connections — the ceiling trips well before RAM). PgBouncer means apps
# point DATABASE_URL at `pgbouncer:6432` instead of `pg:5432`; the
# direct-pg TCP/SNI route at postgres.toscanini.me stays untouched
# so DBeaver and superuser admin still hit the cluster directly.
#   https://github.com/pgbouncer/pgbouncer
# Trade-off: transaction-mode pooling breaks LISTEN/NOTIFY, session-
# scoped SET, and naive prepared statements — each new app needs a
# one-time check that its driver is pooler-aware (Drizzle/Prisma/
# postgres-js all support it via a flag).

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  ...
}:

let
  cfg = config.myStack.appDatabases;

  activeApps = lib.attrNames cfg;
  enabled = activeApps != [ ];

  # App names land as postgres role + database identifiers and the
  # env file path. Force a narrow shape so we don't have to defend
  # any of those downstream.
  nameRegex = "[a-z][a-z0-9_]*";

  envBase = "/etc/nixos/stacks/app-db/secrets";
  clusterEnv = "${envBase}/cluster/env";
  appEnvFile = name: "${envBase}/${name}/env";

  hostRoot = "/home/santiago/selfhost/app-db";
  dataDir = "${hostRoot}/postgres";

  pgImage = "docker.io/library/postgres:18.4-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";

  # The bash body lives at assets/bootstrap.sh (shellcheckable
  # standalone). This wrapper exports the four parameters it reads
  # (APP_NAME, ENV_BASE, CLUSTER_ENV, APP_ENV_FILE) and concatenates
  # the body so it all runs in a single shell with `set -eu` from
  # the systemd script preamble.
  perAppBootstrapScript = name: ''
    set -eu

    export APP_NAME=${lib.escapeShellArg name}
    export EXTRA_DBS=${lib.escapeShellArg (lib.concatStringsSep " " cfg.${name}.extraDatabases)}
    export ENV_BASE=${lib.escapeShellArg envBase}
    export CLUSTER_ENV=${lib.escapeShellArg clusterEnv}
    export APP_ENV_FILE=${lib.escapeShellArg (appEnvFile name)}

    ${builtins.readFile ./assets/bootstrap.sh}
  '';
in
{
  options.myStack.appDatabases = lib.mkOption {
    # An entry's presence IS the enable signal; per-app fields live
    # in the submodule (room to grow: connection caps, extensions...).
    type = lib.types.attrsOf (
      lib.types.submodule (
        { name, ... }:
        {
          options.extraDatabases = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            example = [ "sonarr_log" ];
            description = ''
              Additional databases owned by the same role. Used by the
              *arr apps, which keep config/history and log entries in
              two separate databases behind one login.
            '';
          };
          options.consumers = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ "app-${name}" ];
            example = [ "nextcloud-app" ];
            description = ''
              Container names that must not start before this app's
              bootstrap has materialized the role/db/env file — the
              generated ordering is `podman-<consumer>.service`
              after/wants `app-db-<name>-bootstrap.service`. Default
              fits the apps platform (container `app-<name>`); stack
              tenants set their own container name(s).
            '';
          };
          options.envFile = lib.mkOption {
            type = lib.types.str;
            readOnly = true;
            default = "/etc/nixos/stacks/app-db/secrets/${name}/env";
            description = ''
              Path of the bootstrap-written env file (DATABASE_URL +
              the password under every tenant-read name). Reference
              this instead of hardcoding the path.
            '';
          };
        }
      )
    );
    default = { };
    description = ''
      Per-app Postgres databases on the single shared `pg` cluster.
      Each entry materializes a database + login role owned by that
      role (no PUBLIC connect) and the per-app env file with
      DATABASE_URL. LAN access is the shared
      `postgres.toscanini.me:5432` TCP/SNI route.

      The attribute key is used directly as the postgres role, the
      database name, and the env-file directory — the nameRegex
      assertion enforces the allowed shape.

      See stacks/app-db/README.md.
    '';
  };

  config = lib.mkIf enabled {
    # Validate app names at eval time. The name lands in SQL (via
    # psql's `%I` for the role/db) and in the env file path — catch
    # garbage names at build time, not at first podman exec.
    assertions =
      (map (n: {
        assertion = builtins.match nameRegex n != null;
        message = ''
          myStack.appDatabases."${n}": invalid app name.
          Must match ${nameRegex} — used as the postgres role,
          database, and env-file directory.
        '';
      }) activeApps)
      # `cluster` holds the superuser env and `monitoring` the exporter
      # role env under the same secrets/ tree — a tenant with either
      # name would read the wrong password as its "existing" one (the
      # cluster case: creating a login role that shares the SUPERUSER
      # password) and then rewrite the env file in tenant shape.
      ++ (map (n: {
        assertion =
          !(lib.elem n [
            "cluster"
            "monitoring"
          ]);
        message = ''
          myStack.appDatabases."${n}": reserved name — `cluster` and
          `monitoring` are infrastructure env dirs under secrets/.
        '';
      }) activeApps)
      ++ (lib.concatMap (
        n:
        map (d: {
          assertion = builtins.match nameRegex d != null;
          message = ''
            myStack.appDatabases."${n}".extraDatabases: "${d}" is not a
            valid database name (${nameRegex}).
          '';
        }) cfg.${n}.extraDatabases
      ) activeApps);

    # app-db-net: pg + every app container. pg-wire-net: private bridge
    # carrying the TCP/SNI postgres wire — traefik and pg are its only
    # members, keeping the cluster unreachable from the other web
    # containers (traefik's membership is appended to its list here;
    # containerNetworks lists merge across modules).
    myStack.containerNetworks."pg" = [
      "app-db"
      "pg-wire"
    ];
    myStack.containerNetworks.traefik = [ "pg-wire" ];

    myStack.logStacks.app-db = [
      "pg"
      "pg-exporter"
    ];

    # LAN access for direct-TLS postgres clients (DBeaver, psql, JDBC).
    # One shared hostname for the whole cluster; the client picks the
    # database (and matching role) via the `dbname=` / `user=` fields
    # in its connection string.
    #
    # Per-app hostnames (`pg-<name>.toscanini.me`) would be decorative —
    # all routes would terminate at the same `pg:5432` backend and the
    # host doesn't influence which database the client lands in. One
    # shared route avoids fan-out in traefik rules + pi-hole entries.
    #
    # The TCP route is a single fixed YAML — contributed via the
    # existing `traefikStaticRules` escape hatch (same mechanism
    # nextcloud's dual-router uses). traefik.nix gates the :5432
    # entrypoint + firewall on `myStack.appDatabases != { }`.
    myStack.traefikStaticRules."postgres-tcp.yml" = builtins.readFile ./assets/traefik-tcp.yml;
    myStack.dnsHosts = [ "${config.myStack.lanIp} postgres.toscanini.me" ];

    # The plain-TCP host port (see `ports` on the pg container).
    networking.firewall.allowedTCPPorts = [ 5433 ];

    myStack.stateDirs = {
      "${hostRoot}" = { };
      "${dataDir}" = {
        uid = 70;
        mode = "0700";
      };
      "${envBase}/cluster".mode = "0700";
    }
    // lib.listToAttrs (map (n: lib.nameValuePair "${envBase}/${n}" { mode = "0700"; }) activeApps);

    # Cluster bootstrap (one-shot: generate superuser POSTGRES_PASSWORD)
    # + per-app bootstrap services (idempotent SQL: materialize role +
    # database, write per-app env file). Combined via lib.mkMerge so
    # the two assignments don't conflict.
    systemd.services = lib.mkMerge [
      {
        "pg-cluster-bootstrap" = {
          description = "Bootstrap pg cluster: generate superuser POSTGRES_PASSWORD on first boot";
          before = [ "podman-pg.service" ];
          wantedBy = [ "podman-pg.service" ];
          after = [ "local-fs.target" ];
          path = [
            pkgs.openssl
            pkgs.coreutils
          ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            Restart = "on-failure";
            RestartSec = "5s";
          };
          script = ''
            set -eu
            # state-dirs.service also declares this dir, but there is no
            # ordering edge between the two oneshots — create it here so
            # a fresh restore can't race (install -d is idempotent).
            install -d -m 0700 -o santiago -g users "${envBase}/cluster"
            if [ ! -e "${clusterEnv}" ]; then
              PASSWORD=$(openssl rand -hex 32)
              install -m 0600 -o santiago -g users /dev/stdin "${clusterEnv}" <<EOF
            POSTGRES_PASSWORD=$PASSWORD
            EOF
            fi
          '';
        };
      }

      # Per-app bootstrap services: SQL-driven role+db materialization.
      # Run as santiago so we can `podman exec` into rootless pg.
      (lib.listToAttrs (
        map (
          name:
          lib.nameValuePair "app-db-${name}-bootstrap" {
            description = "Materialize role + database `${name}` on shared pg cluster";
            # Gate every declared consumer container on the bootstrap
            # (role/db/env file must exist before the tenant dials pg).
            before = map (c: "podman-${c}.service") cfg.${name}.consumers;
            wantedBy = map (c: "podman-${c}.service") cfg.${name}.consumers;
            after = [ "podman-pg.service" ];
            wants = [ "podman-pg.service" ];
            path = [
              pkgs.openssl
              pkgs.coreutils
              pkgs.gnugrep
              pkgs.gnused
              pkgs.podman
            ];
            serviceConfig = {
              Type = "oneshot";
              RemainAfterExit = true;
              User = "santiago";
              Environment = "XDG_RUNTIME_DIR=/run/user/1000";
              Restart = "on-failure";
              RestartSec = "5s";
            };
            script = perAppBootstrapScript name;
          }
        ) activeApps
      ))

      # pg readiness gate: "podman-pg finished" only means `podman run
      # -d` returned; postgres accepts connections ~1s later, and
      # tenants that dial fatally at startup (pocket-id, gatus) crash
      # into --rm oblivion inside that window. ExecStartPost holds the
      # unit — and everything ordered after it — until the server
      # actually answers.
      {
        podman-pg.serviceConfig.ExecStartPost = pkgs.writeShellScript "wait-pg-ready" ''
          for _ in $(seq 1 60); do
            ${pkgs.podman}/bin/podman exec pg pg_isready -q && exit 0
            sleep 1
          done
          echo "pg did not become ready within 60s" >&2
          exit 1
        '';
      }

      # Direct pg edge on every consumer. At boot the bootstrap chain
      # orders this transitively (consumer → bootstrap → pg), but
      # systemd ordering is per-transaction: a mass restart (a
      # common.nix change touching every unit) re-queues consumers while
      # the already-active bootstrap stays put, and tenants then race
      # pg's start. Declaring the edge on the consumer itself keeps it
      # in every transaction.
      (lib.listToAttrs (
        lib.concatMap (
          name:
          map (
            c:
            lib.nameValuePair "podman-${c}" {
              after = [ "podman-pg.service" ];
              wants = [ "podman-pg.service" ];
            }
          ) cfg.${name}.consumers
        ) activeApps
      ))
    ];

    virtualisation.oci-containers.containers."pg" = mkRootlessContainer {
      image = pgImage;
      environmentFiles = [ clusterEnv ];
      environment = {
        # Postgres 18 default PGDATA is /var/lib/postgresql/<major>/docker
        # for pg_upgrade ergonomics; we mount at the legacy path and pin
        # PGDATA so initdb doesn't bail with "unused mount/volume".
        PGDATA = "/var/lib/postgresql/data";
      };
      volumes = [ "${dataDir}:/var/lib/postgresql/data" ];
      ports = [
        # Plain-TCP LAN access for tenants that can't ride a bridge:
        # the gluetun-netns *arrs dial 192.168.0.2:5433 directly
        # (their Npgsql client can't do the direct-TLS handshake the
        # traefik :5432 TCP/SNI route requires — that route stays the
        # TLS front door for DBeaver-style clients).
        "5433:5432"
      ];
      cmd = [
        "postgres"
        "-c"
        "shared_buffers=256MB"
        "-c"
        "max_connections=200"
        "-c"
        "work_mem=8MB"
        "-c"
        "maintenance_work_mem=64MB"
        "-c"
        "effective_cache_size=1GB"
        "-c"
        "log_min_messages=warning"
      ];
      extraOptions = [
        "--cpus=2"
        "--memory=2g"
        "--pids-limit=500"
      ];
    };
  };
}
