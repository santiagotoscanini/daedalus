# monitoring — prometheus + grafana + node-exporter + cadvisor.
#
# Four containers on a shared bridge `monitoring-net`:
#   - prometheus scrapes node-exporter and cadvisor by container name
#     (`node-exporter:9100`, `cadvisor:8080`), so they need DNS
#     visibility — same pattern as the nextcloud stack.
#   - grafana queries prometheus on `prometheus:9090`.
#   - Only prometheus + grafana publish to the host (Traefik dials them
#     for their UIs); node-exporter + cadvisor are internal-only.
#
# `prometheus.yml` and the dashboards dir are now nix-generated and
# bind-mounted from /nix/store:
#
#   * `prometheusConfig` is built from a base scrape-job list defined
#     below (translated 1:1 from the previous hand-edited prometheus.yml)
#     plus any per-stack contributions via `myStack.prometheusScrapes`.
#     Per-stack stacks therefore add their own scrape jobs without
#     touching this module.
#
#   * `dashboardsDir` combines the static JSON files under
#     `./grafana-dashboards/` (committed to /etc/nixos/) with any
#     dashboards a per-stack module emits via
#     `myStack.grafanaDashboards`. Stacks like the supabase wrapper
#     emit one dashboard per project from a JSON template.
#
# When a stack's scrape list or dashboard set changes, the resulting
# /nix/store path changes, the container's systemd unit definition
# changes, and nixos-rebuild switch automatically restarts the
# affected container. No manual reload step required.
#
# To wire local `claude` CLI to Grafana via MCP (replace {TOKEN} with a
# Grafana service-account token from
# https://grafana.toscanini.me/org/serviceaccounts):
#
#   claude mcp add --transport stdio --scope user grafana -- \
#       podman run --rm -i \
#       -e GRAFANA_URL=https://grafana.toscanini.me \
#       -e GRAFANA_SERVICE_ACCOUNT_TOKEN={TOKEN} \
#       docker.io/grafana/mcp-grafana -t stdio

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  # Base scrape jobs — every job that was previously hand-edited in
  # /home/santiago/selfhost/monitoring/prometheus/app/prometheus.yml,
  # translated to nix attrset shape. The supabase-db job is NOT here;
  # it now comes through `myStack.prometheusScrapes` from the supabase
  # wrapper, one entry per declared project.
  baseScrapes = [
    { job_name = "prometheus";
      static_configs = [ { targets = [ "prometheus:9090" ]; } ]; }

    { job_name = "node_exporter";
      static_configs = [ { targets = [ "host.containers.internal:9100" ]; } ]; }

    { job_name = "cadvisor";
      static_configs = [ { targets = [ "cadvisor:8080" ]; } ]; }
  ];

  # Generate prometheus.yml from the merged scrape list. Prometheus
  # accepts JSON as a YAML 1.1 superset, so `toJSON` is sufficient —
  # avoids any quoting/escaping pitfalls of a hand-rolled YAML writer.
  prometheusConfig = pkgs.writeText "prometheus.yml" (builtins.toJSON {
    global = {
      scrape_interval = "15s";
      evaluation_interval = "15s";
    };
    scrape_configs = baseScrapes ++ config.myStack.prometheusScrapes;
  });

  # /etc/prometheus needs to be a directory (Prometheus also looks
  # there for rule files). Wrap the single generated yml in a dir so
  # adding alert_rules.yml later is a one-line extension here.
  prometheusDir = pkgs.runCommand "prometheus-etc" { } ''
    mkdir -p $out
    cp ${prometheusConfig} $out/prometheus.yml
  '';

  # Combine three sources, all bind-mounted as a single /nix/store dir
  # into the grafana container:
  #   1. Static OS-generic dashboards committed under
  #      /etc/nixos/modules/grafana-dashboards/ (root of /var/lib/
  #      grafana/dashboards inside the container).
  #   2. Per-stack dashboards from myStack.grafanaDashboards. Also at
  #      root.
  #   3. Per-stack dashboards in folders, from
  #      myStack.grafanaDashboardsByFolder. Placed under named
  #      subdirectories; the grafana provisioner uses
  #      `foldersFromFilesStructure: true` to surface them as
  #      Grafana sidebar folders.
  dashboardsDir = pkgs.runCommand "grafana-dashboards" { } (
    ''
      mkdir -p $out
      cp -r ${./assets/dashboards}/. $out/
    ''
    + lib.concatStringsSep "\n" (lib.mapAttrsToList (name: content:
      "cp ${pkgs.writeText "${name}.json" content} $out/${name}.json"
    ) config.myStack.grafanaDashboards)
    + "\n"
    + lib.concatStringsSep "\n" (lib.mapAttrsToList (folder: dashboards: ''
      mkdir -p "$out/${folder}"
    '' + lib.concatStringsSep "\n" (lib.mapAttrsToList (name: content:
      "cp ${pkgs.writeText "${name}.json" content} \"$out/${folder}/${name}.json\""
    ) dashboards)) config.myStack.grafanaDashboardsByFolder)
  );
in
{
  myStack.containerNetworks = {
    prometheus    = "monitoring";
    grafana       = "monitoring";
    cadvisor      = "monitoring";
    node-exporter = null;        # host net (sees real enp3s0)
  };

  myStack.webApps = {
    prometheus = { hostname = "prometheus.toscanini.me"; port = 9090; };
    grafana    = { hostname = "grafana.toscanini.me";    port = 3000; };
  };

  myStack.homepageServices."Monitoring" = [
    {
      name = "Grafana";
      href = "https://grafana.toscanini.me/bookmarks";
      description = "Dashboards (prometheus + loki)";
      icon = "grafana.png";
      siteMonitor = "http://host.containers.internal:3000";
      widget = {
        type = "grafana";
        version = 2;
        url = "http://host.containers.internal:3000";
        username = "{{HOMEPAGE_VAR_GRAFANA_USER}}";
        password = "{{HOMEPAGE_VAR_GRAFANA_PASS}}";
      };
    }
    {
      name = "Prometheus";
      href = "https://prometheus.toscanini.me";
      description = "TSDB — 30d / 100GB retention";
      icon = "prometheus.png";
      siteMonitor = "http://host.containers.internal:9090";
      widget = {
        type = "prometheus";
        url = "http://host.containers.internal:9090";
      };
    }
  ];

  virtualisation.oci-containers.containers.prometheus = mkRootlessContainer {
    image = "docker.io/prom/prometheus:v3.9.1";

    ports = [ "9090:9090" ];

    cmd = [
      "--config.file=/etc/prometheus/prometheus.yml"
      "--storage.tsdb.path=/prometheus"
      "--web.enable-lifecycle"
      "--storage.tsdb.retention.time=30d"
      "--storage.tsdb.retention.size=100GB"
    ];

    volumes = [
      # /nix/store-backed config dir. nixos-rebuild restarts the
      # container whenever the derivation hash changes.
      "${prometheusDir}:/etc/prometheus:ro"
      # TSDB stays on disk under selfhost.
      "/home/santiago/selfhost/monitoring/prometheus/data:/prometheus"
    ];

    extraOptions = [
      # `user=0:0` in the old compose; in our rootless setup that
      # already means host santiago, which owns the data dirs. The
      # prom/prometheus image's default user is `nobody` (65534),
      # which would map to host 100533 — owner of nothing. Override.
      "--user=0:0"
      "--network=monitoring-net"
    ];
  };

  virtualisation.oci-containers.containers.grafana = mkRootlessContainer {
    image = "docker.io/grafana/grafana:12.3.1";
    dependsOn = [ "prometheus" ];

    ports = [ "3000:3000" ];

    volumes = [
      "/home/santiago/selfhost/monitoring/grafana/data:/var/lib/grafana"
      "/home/santiago/selfhost/monitoring/grafana/app/provisioning/datasources:/etc/grafana/provisioning/datasources:ro"
      "/home/santiago/selfhost/monitoring/grafana/app/provisioning/dashboards:/etc/grafana/provisioning/dashboards:ro"
      "/home/santiago/selfhost/monitoring/grafana/app/provisioning/alerting:/etc/grafana/provisioning/alerting:ro"
      # Static + per-stack dashboards live in /nix/store.
      "${dashboardsDir}:/var/lib/grafana/dashboards:ro"
    ];

    environment = {
      GF_USERS_ALLOW_SIGN_UP = "false";
      GF_SERVER_ROOT_URL = "https://grafana.toscanini.me";
      GF_SERVER_SERVE_FROM_SUB_PATH = "false";
    };

    # GF_SECURITY_ADMIN_USER + GF_SECURITY_ADMIN_PASSWORD.
    environmentFiles = [ "/etc/nixos/stacks/monitoring/secrets/grafana.env" ];

    extraOptions = [
      "--user=0:0"
      "--network=monitoring-net"
    ];
  };

  # Reads /proc, /sys, / read-only and exports host metrics on :9100.
  # Internal to monitoring-net; reached by prometheus as
  # `node-exporter:9100`.
  virtualisation.oci-containers.containers.node-exporter = mkRootlessContainer {
    image = "docker.io/prom/node-exporter:latest";

    cmd = [
      "--path.procfs=/host/proc"
      "--path.sysfs=/host/sys"
      "--path.rootfs=/rootfs"
      "--collector.filesystem.mount-points-exclude=^/(sys|proc|dev|host|etc)($|/)"
    ];

    volumes = [
      "/run/udev/data:/run/udev/data:ro"
      "/proc:/host/proc:ro"
      "/sys:/host/sys:ro"
      "/:/rootfs:ro"
    ];

    extraOptions = [
      # Run in the host's network namespace so node-exporter sees
      # `enp3s0` (host NIC) and reports the real host network stats.
      # Inside a bridge (or pasta) netns it would see only the
      # container's synthetic `eth0` and report meaningless 0 traffic.
      "--network=host"
    ];
  };

  # In the old compose this read /var/lib/docker AND /var/run to
  # discover docker containers. Docker is gone; both mounts are
  # dropped. The /var/run mount specifically broke podman crun (it
  # overlayed the container's own /run, hiding /run/.containerenv that
  # crun expects).
  #
  # cadvisor still reports cgroup-level container stats from
  # /sys/fs/cgroup (via the /sys mount) — basic per-container CPU/RAM
  # works, just less rich than the docker-aware view used to be.
  virtualisation.oci-containers.containers.cadvisor = mkRootlessContainer {
    image = "gcr.io/cadvisor/cadvisor:latest";

    volumes = [
      "/:/rootfs:ro"
      "/sys:/sys:ro"
      "/dev/disk:/dev/disk:ro"
      "/etc/machine-id:/etc/machine-id:ro"
    ];

    extraOptions = [
      "--privileged"
      "--device=/dev/kmsg"
      "--network=monitoring-net"
    ];
  };
}
