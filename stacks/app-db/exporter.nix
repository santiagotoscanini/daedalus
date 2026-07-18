# app-db/exporter.nix — single postgres_exporter scraping the shared
# `pg` cluster. Per-database metrics carry a `datname` label, which the
# dashboard's `$app` template variable resolves to.
#
# Topology:
#   monitoring-net   prometheus on this bridge reaches pg-exporter:9187.
#   app-db-net       pg-exporter dials pg:5432 over this bridge.
#
# Auth:
#   The exporter connects as a dedicated `monitoring` role (LOGIN +
#   pg_monitor — read-only stats, no table data), materialized by the
#   pg-monitoring-role-bootstrap oneshot with its password stored at
#   /etc/nixos/stacks/app-db/secrets/monitoring/env (machine-generated
#   class; rotate by deleting the file + rebuild). The DSN env file is
#   rendered from it at activation into /run/pg-exporter-config/env
#   (tmpfs, 0600 santiago — podman injects it pre-userns-remap). A
#   compromised exporter reads statistics, not app data.
#
# Gated behind `lib.mkIf enabled` — a no-op until at least one app has
# `myStack.appDatabases.<name>.enable = true`.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkSecretRender,
  ...
}:

let
  enabled = config.myStack.appDatabases != { };

  clusterEnv = "/etc/nixos/stacks/app-db/secrets/cluster/env";
  monEnv = "/etc/nixos/stacks/app-db/secrets/monitoring/env";
  cfgDir = "/run/pg-exporter-config";
  # postgres_exporter only reads DATA_SOURCE_NAME from env — no
  # DATA_SOURCE_NAME_FILE support (still true as of v0.20). So we
  # render the DSN as a KEY=VAL file and feed it via podman's
  # --env-file (oci-containers `environmentFiles`).
  envFile = "${cfgDir}/env";

in
{
  config = lib.mkIf enabled {
    # app-db-net to dial pg; monitoring-net so prometheus scrapes it.
    myStack.containerNetworks."pg-exporter" = [
      "app-db"
      "monitoring"
    ];

    myStack.stateDirs."/etc/nixos/stacks/app-db/secrets/monitoring".mode = "0700";

    # Materialize the read-only `monitoring` role (LOGIN + pg_monitor).
    # Same machine-generated idiom as the per-app bootstraps: password
    # born on the box, kept in secrets/, ALTER ROLE re-syncs it every
    # run so rotation = delete the file + rebuild. (`monitoring` shares
    # the secrets/ namespace with app databases — don't name an app
    # "monitoring".)
    systemd.services."pg-monitoring-role-bootstrap" = {
      description = "Materialize the pg_monitor role for pg-exporter";
      before = [ "pg-exporter-config.service" ];
      wantedBy = [ "pg-exporter-config.service" ];
      after = [ "podman-pg.service" ];
      wants = [ "podman-pg.service" ];
      path = [
        pkgs.openssl
        pkgs.coreutils
        pkgs.gnugrep
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
      script = ''
        set -eu
        for i in $(seq 1 60); do
          podman exec pg pg_isready -U postgres -d postgres >/dev/null 2>&1 && break
          sleep 1
        done
        podman exec pg pg_isready -U postgres -d postgres >/dev/null 2>&1 || {
          echo "pg not ready after 60s" >&2
          exit 1
        }

        if [ -e "${monEnv}" ]; then
          MON_PWD=$(grep '^POSTGRES_PASSWORD=' "${monEnv}" | head -1 | cut -d= -f2-)
        else
          MON_PWD=$(openssl rand -hex 32)
        fi
        SUPER_PWD=$(grep '^POSTGRES_PASSWORD=' "${clusterEnv}" | head -1 | cut -d= -f2-)

        PGPASSWORD="$SUPER_PWD" podman exec -i -e PGPASSWORD pg \
          psql -X -v ON_ERROR_STOP=1 -v qpwd="$MON_PWD" -U postgres -d postgres <<'SQL'
        SELECT 'CREATE ROLE monitoring LOGIN'
        WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitoring')
        \gexec
        ALTER ROLE monitoring PASSWORD :'qpwd';
        GRANT pg_monitor TO monitoring;
        SQL

        install -m 0600 -o santiago -g users /dev/stdin "${monEnv}" <<EOF
        POSTGRES_PASSWORD=$MON_PWD
        EOF
      '';
    };

    # Compose the DSN from the monitoring-role env at activation time.
    systemd.services."pg-exporter-config" = mkSecretRender {
      description = "Render pg-exporter DSN from the monitoring role env";
      gates = [ "podman-pg-exporter.service" ];
      after = [ "pg-monitoring-role-bootstrap.service" ];
      wants = [ "pg-monitoring-role-bootstrap.service" ];
      dir = cfgDir;
      file = envFile;
      mode = "0600";
      prep = ''
        MON_PWD=$(grep '^POSTGRES_PASSWORD=' "${monEnv}" | head -1 | cut -d= -f2-)
        DSN="postgresql://monitoring:$MON_PWD@pg:5432/postgres?sslmode=disable"
      '';
      content = "DATA_SOURCE_NAME=$DSN";
    };

    virtualisation.oci-containers.containers."pg-exporter" = mkRootlessContainer {
      image = "quay.io/prometheuscommunity/postgres-exporter:v0.20.1@sha256:ac5ec343104fae0e2d84a27bb8d69b38430a11910c5382cad85d478d2bab713e";
      # DATA_SOURCE_NAME is read directly from podman's --env-file.
      # The DSN file stays out of `podman inspect` output (env file
      # contents aren't reflected in Config.Env when injected via
      # --env-file).
      environmentFiles = [ envFile ];
      cmd = [
        "--web.listen-address=:9187"
        "--no-auto-discover-databases"
        "--log.level=warn"
      ];
      extraOptions = [
        "--cpus=0.25"
        "--memory=64m"
        "--pids-limit=100"
      ];
    };

    # Prometheus scrape: one job for the shared cluster. Per-database
    # metrics are broken out by the `datname` label automatically.
    myStack.prometheusScrapes = [
      {
        job_name = "pg";
        static_configs = [
          {
            targets = [ "pg-exporter:9187" ];
          }
        ];
      }
    ];

    # Per-app cluster dashboard.
    myStack.grafanaDashboardsByFolder."Services"."pg-overview" =
      builtins.readFile ./assets/postgres.json;
  };
}
