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

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  enabled = config.myStack.appDatabases != { };

  clusterEnv = "/etc/nixos/stacks/app-db/secrets/cluster/env";
  cfgDir     = "/run/pg-exporter-config";
  # postgres_exporter v0.18.1 only reads DATA_SOURCE_NAME from env,
  # not from a file env (no DATA_SOURCE_NAME_FILE support). So we
  # render the DSN as a KEY=VAL file and feed it via podman's
  # --env-file (oci-containers `environmentFiles`).
  envFile    = "${cfgDir}/env";

  # In-container UID 65534 (nobody, the user the postgres-exporter
  # image runs as) → host UID 99999 + 65534 = 165533.
  exporterHostUid = 165533;
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

    # Compose the DSN from the cluster superuser env at activation
    # time. Atomic mv so the exporter never reads a half-written file.
    systemd.services."pg-exporter-config" = {
      description = "Render pg-exporter DSN from the cluster superuser env";
      before      = [ "podman-pg-exporter.service" ];
      wantedBy    = [ "podman-pg-exporter.service" ];
      after       = [ "local-fs.target" "pg-cluster-bootstrap.service" ];
      wants       = [ "pg-cluster-bootstrap.service" ];
      path        = [ pkgs.coreutils pkgs.gnugrep pkgs.gnused ];
      serviceConfig = {
        Type            = "oneshot";
        RemainAfterExit = true;
        Restart         = "on-failure";
        RestartSec      = "5s";
      };
      script = ''
        set -eu
        # cfgDir is read by santiago (env file mount happens at
        # podman-run time, before user-NS remap); mode 0755 + owned by
        # santiago is enough. The env file itself stays 0600.
        install -d -m 0755 -o santiago -g users ${cfgDir}

        umask 077
        SUPER_PWD=$(grep '^POSTGRES_PASSWORD=' "${clusterEnv}" | head -1 | cut -d= -f2-)
        DSN="postgresql://postgres:$SUPER_PWD@pg:5432/postgres?sslmode=disable"

        install -m 0600 -o santiago -g users /dev/stdin "${envFile}" <<EOF
        DATA_SOURCE_NAME=$DSN
        EOF
      '';
    };

    virtualisation.oci-containers.containers."pg-exporter" =
      mkRootlessContainer {
        image = "quay.io/prometheuscommunity/postgres-exporter:v0.20.1";
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
    myStack.prometheusScrapes = [{
      job_name = "pg";
      static_configs = [{
        targets = [ "pg-exporter:9187" ];
      }];
    }];

    # Per-app cluster dashboard.
    myStack.grafanaDashboards."pg-overview" =
      builtins.readFile ./assets/postgres.json;
  };
}
