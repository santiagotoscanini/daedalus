# app-db — single shared Postgres cluster, one database per app.
#
# Activated when at least one entry in `myStack.appDatabases` is
# `enable = true`. Materializes:
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
# TODO: front this with PgBouncer (transaction pooling) once a second
# app lands on the cluster. With ~10 vibe-coded apps each opening
# ORM-style pools of 10–25 connections, max_connections=200 is a
# real ceiling we'll trip well before RAM. PgBouncer would mean apps
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

  # App names land as postgres role + database identifiers, the LAN
  # hostname `pg-<name>.toscanini.me`, the env file path, etc. Force a
  # narrow shape so we don't have to defend any of those downstream.
  nameRegex = "[a-z][a-z0-9_]*";

  envBase = "/etc/nixos/stacks/app-db/secrets";
  clusterEnv = "${envBase}/cluster/env";
  appEnvFile = name: "${envBase}/${name}/env";

  hostRoot = "/home/santiago/selfhost/app-db";
  dataDir = "${hostRoot}/postgres";

  pgImage = "docker.io/library/postgres:18.4-alpine";

  # The bash body lives at assets/bootstrap.sh (shellcheckable
  # standalone). This wrapper exports the four parameters it reads
  # (APP_NAME, ENV_BASE, CLUSTER_ENV, APP_ENV_FILE) and concatenates
  # the body so it all runs in a single shell with `set -eu` from
  # the systemd script preamble.
  perAppBootstrapScript = name: ''
    set -eu

    export APP_NAME=${lib.escapeShellArg name}
    export ENV_BASE=${lib.escapeShellArg envBase}
    export CLUSTER_ENV=${lib.escapeShellArg clusterEnv}
    export APP_ENV_FILE=${lib.escapeShellArg (appEnvFile name)}

    ${builtins.readFile ./assets/bootstrap.sh}
  '';
in
{
  options.myStack.appDatabases = lib.mkOption {
    # Empty submodule: an entry's presence IS the enable signal. The
    # submodule is kept (rather than `attrsOf null`) so we have a
    # place to grow per-app fields (connection caps, extensions, ...)
    # without churning the call sites.
    type = lib.types.attrsOf (lib.types.submodule { });
    default = { };
    description = ''
      Per-app Postgres databases on the single shared `pg` cluster.
      Each entry materializes a database + login role owned by that
      role (no PUBLIC connect), the per-app env file with DATABASE_URL,
      and a LAN TCP/SNI route `pg-<name>.toscanini.me:5432`.

      The attribute key is used directly as the postgres role,
      database, and hostname segment — see [[nameRegex]] for the
      allowed shape.

      See stacks/app-db/README.md.
    '';
  };

  config = lib.mkIf enabled {
    # Validate app names at eval time. The name lands unquoted in SQL
    # (via psql's `%I` for the role/db, but a hyphen would still trip
    # the LAN hostname `pg-<n>.toscanini.me` and the env file path).
    # Catch garbage names at build time, not at first podman exec.
    assertions = map (n: {
      assertion = builtins.match nameRegex n != null;
      message = ''
        myStack.appDatabases."${n}": invalid app name.
        Must match ${nameRegex} — used as the postgres role,
        database, and env-file directory.
      '';
    }) activeApps;

    # Shared bridge: pg + every app container join `app-db-net`.
    myStack.containerNetworks."pg" = "app-db";

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
    myStack.dnsHosts = [ "192.168.0.2 postgres.toscanini.me" ];

    systemd.tmpfiles.rules = [
      "d ${hostRoot}                  0755 santiago users  -"
      "d ${dataDir}                   0700 100069   100069 -"
      "d ${envBase}/cluster           0700 santiago users  -"
    ]
    ++ (map (n: "d ${envBase}/${n}  0700 santiago users  -") activeApps);

    # Cluster bootstrap (one-shot: generate superuser POSTGRES_PASSWORD)
    # + per-app bootstrap services (idempotent SQL: materialize role +
    # database, write per-app env file). Combined via lib.mkMerge so
    # the two assignments don't conflict.
    systemd.services = lib.mkMerge [
      {
        # pg-wire-net: private bridge carrying the TCP/SNI postgres
        # wire; traefik and pg are its only members. Declared by hand
        # (mirrors mkBridgeUnit in platform/common.nix) because
        # containerNetworks only creates a container's PRIMARY bridge,
        # and this bridge is a secondary for both of its members.
        "podman-network-pg-wire-net" = {
          description = "Create the pg-wire-net podman bridge";
          after = [
            "network-online.target"
            "linger-users.service"
          ];
          wants = [
            "network-online.target"
            "linger-users.service"
          ];
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            User = "santiago";
            Environment = "XDG_RUNTIME_DIR=/run/user/1000";
            Restart = "on-failure";
            RestartSec = "1s";
            ExecStart = "${pkgs.podman}/bin/podman network create --ignore pg-wire-net";
          };
        };
        # The fleet-wide override only orders pg after its PRIMARY
        # bridge (app-db-net); order the secondary bridge explicitly.
        "podman-pg" = {
          after = [ "podman-network-pg-wire-net.service" ];
          wants = [ "podman-network-pg-wire-net.service" ];
        };
        # Traefik's generated override likewise only orders it after its
        # primary bridge (traefik-net); order its secondary here too.
        "podman-traefik" = {
          after = [ "podman-network-pg-wire-net.service" ];
          wants = [ "podman-network-pg-wire-net.service" ];
        };

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
            # ${envBase}/cluster is pre-created by tmpfiles.rules.
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
            before = [ "podman-app-${name}.service" ];
            wantedBy = [ "podman-app-${name}.service" ];
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
        # Primary bridge: app containers dial `pg` here for the
        # in-cluster DATABASE_URL (postgresql://...@pg:5432/<db>).
        "--network=app-db-net"
        # Secondary bridge: traefik dials `pg:5432` here for the TCP/SNI
        # route that exposes the cluster on the LAN as
        # `postgres.toscanini.me:5432`. A dedicated bridge (not
        # traefik-net) keeps the cluster unreachable from the other web
        # containers; traefik is the only other member. Created by the
        # podman-network-pg-wire-net oneshot above.
        "--network=pg-wire-net"
        "--cpus=2"
        "--memory=2g"
        "--pids-limit=500"
      ];
    };
  };
}
