# app-db/exporter.nix — single postgres_exporter scraping the shared
# `pg` cluster. Per-database metrics carry a `datname` label, which the
# dashboard's `$app` template variable resolves to.
#
# Topology:
#   monitoring-net   prometheus on this bridge reaches pg-exporter:9187.
#   app-db-net       pg-exporter dials pg:5432 over this bridge.
#
# Auth:
#   The exporter connects as the cluster's `postgres` superuser. Its
#   DSN is composed at activation time from POSTGRES_PASSWORD in
#   /etc/nixos/stacks/app-db/secrets/cluster/env, written into
#   /run/pg-exporter-config/dsn (tmpfs, 0600, owned by the exporter's
#   in-container UID).
#
# Gated behind `lib.mkIf enabled` — a no-op until at least one app has
# `myStack.appDatabases.<name>.enable = true`.

{
  config,
  lib,
  mkRootlessContainer,
  mkSecretRender,
  ...
}:

let
  enabled = config.myStack.appDatabases != { };

  clusterEnv = "/etc/nixos/stacks/app-db/secrets/cluster/env";
  cfgDir = "/run/pg-exporter-config";
  # postgres_exporter only reads DATA_SOURCE_NAME from env — no
  # DATA_SOURCE_NAME_FILE support (still true as of v0.20). So we
  # render the DSN as a KEY=VAL file and feed it via podman's
  # --env-file (oci-containers `environmentFiles`).
  envFile = "${cfgDir}/env";

in
{
  config = lib.mkIf enabled {
    # Declare pg-exporter's primary bridge so common.nix forces the
    # systemd unit to Type=oneshot. Without this the unit defaults to
    # Type=notify (sdnotify=conmon) which doesn't survive rootless
    # podman's user-cgroup migration → unit fails with
    # `Failed with result 'protocol'`. The actual --network= flags
    # stay in extraOptions below (common.nix doesn't auto-inject).
    myStack.containerNetworks."pg-exporter" = "app-db";

    # Compose the DSN from the cluster superuser env at activation time.
    systemd.services."pg-exporter-config" = mkSecretRender {
      description = "Render pg-exporter DSN from the cluster superuser env";
      gates = [ "podman-pg-exporter.service" ];
      after = [ "pg-cluster-bootstrap.service" ];
      wants = [ "pg-cluster-bootstrap.service" ];
      dir = cfgDir;
      file = envFile;
      mode = "0600";
      prep = ''
        SUPER_PWD=$(grep '^POSTGRES_PASSWORD=' "${clusterEnv}" | head -1 | cut -d= -f2-)
        DSN="postgresql://postgres:$SUPER_PWD@pg:5432/postgres?sslmode=disable"
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
        "--network=app-db-net"
        "--network=monitoring-net"
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
