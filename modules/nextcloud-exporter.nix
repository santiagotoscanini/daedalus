# nextcloud-exporter — postgres-exporter targeting nextcloud-postgres,
# producing accurate file metrics that the upstream Nextcloud
# /metrics endpoint cannot (its FilesByType filters
# `WHERE path LIKE 'files/%'` and so misses every External Storage
# row — see modules/nextcloud.nix for the layout).
#
# Architecture:
#   - On `nextcloud-net` bridge so it can reach `nextcloud-postgres`
#     by name (the DB itself never gets a host port).
#   - Publishes its `:9187` to the host so prometheus on the
#     `monitoring-net` bridge can scrape via host.containers.internal,
#     same pattern as cloudflared/traefik metrics.
#   - Reuses /etc/nixos/containers/nextcloud/env for PG_PASS; DSN is
#     constructed at start in the entrypoint shell, so the password
#     never appears in the systemd unit ExecStart.
#   - --disable-default-metrics + --disable-settings-metrics drop the
#     postgres-internal metrics (pg_stat_database etc.) — cAdvisor and
#     pg's own logs are enough; we only want our custom queries.
#
# Custom SQL lives at
# /home/santiago/selfhost/monitoring/nextcloud-exporter/queries.yaml
# and is bind-mounted read-only. Edits there are picked up on next
# scrape (no restart needed beyond at most a 60s cache_seconds).
#
# The upstream FilesByType exporter is disabled in Nextcloud config
# via `openmetrics_skipped_classes` (set imperatively via occ — see
# the comment in modules/nextcloud.nix). This avoids two competing
# `nextcloud_files`-shaped metrics; ours are renamed to
# `nextcloud_files_*` and `nextcloud_storage_*` to be unambiguous.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.nextcloud-exporter = "nextcloud";


  myStack.prometheusScrapes = [{
    job_name = "nextcloud-exporter";
    static_configs = [{ targets = [ "host.containers.internal:9187" ]; }];
  }];

  virtualisation.oci-containers.containers.nextcloud-exporter = mkRootlessContainer {
    image = "quay.io/prometheuscommunity/postgres-exporter:v0.17.1";
    dependsOn = [ "nextcloud-postgres" ];

    ports = [ "9187:9187" ];

    volumes = [
      "/home/santiago/selfhost/monitoring/nextcloud-exporter/queries.yaml:/etc/queries.yaml:ro"
    ];

    # Provides PG_PASS (shared with nextcloud-app / nextcloud-postgres).
    environmentFiles = [ "/etc/nixos/containers/nextcloud/env" ];

    # Build DATA_SOURCE_NAME at start so the password never appears
    # in the systemd unit. The image's default entrypoint is
    # `/bin/postgres_exporter`; we wrap it in sh -c to do the export.
    entrypoint = "/bin/sh";
    cmd = [
      "-c"
      ''
        export DATA_SOURCE_NAME="postgresql://nc_postgres:$PG_PASS@nextcloud-postgres:5432/nc_postgres?sslmode=disable" && \
        exec /bin/postgres_exporter \
          --extend.query-path=/etc/queries.yaml \
          --disable-default-metrics \
          --disable-settings-metrics
      ''
    ];

    extraOptions = [
      "--network=nextcloud-net"
    ];
  };
}
