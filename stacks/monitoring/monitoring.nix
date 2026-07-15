# monitoring — prometheus + grafana + node-exporter + cadvisor.
#
# Four containers on `monitoring-net`:
#   - prometheus scrapes node-exporter and cadvisor by container DNS
#     (e.g. `node-exporter:9100`, `cadvisor:8080`).
#   - grafana queries prometheus on `prometheus:9090`.
#   - prometheus + grafana also join traefik-net so (a) traefik dials
#     them by container DNS, and (b) prometheus reaches any other
#     traefik-net-attached stack (litellm:4000, immich:8081, …) without
#     per-stack host-port publishing.
#   - prometheus keeps its host port :9090 for external scrapers /
#     remote_write / federation; grafana drops its host port.
#
# `prometheus.yml` and the dashboards dir are nix-generated:
#   - `prometheusConfig`: base scrape list + each stack's
#     `myStack.prometheusScrapes` contribution.
#   - `dashboardsDir`: static JSON under ./assets/dashboards/, plus
#     `myStack.grafanaDashboards` (root) and `grafanaDashboardsByFolder`
#     (organized into sidebar folders via `foldersFromFilesStructure`).
# Changing either changes the /nix/store hash → container restarts on
# rebuild. No manual reload.
#
# Wire local `claude` to Grafana via MCP (token from
# https://grafana.toscanini.me/org/serviceaccounts):
#   claude mcp add --transport stdio --scope user grafana -- \
#     podman run --rm -i \
#     -e GRAFANA_URL=https://grafana.toscanini.me \
#     -e GRAFANA_SERVICE_ACCOUNT_TOKEN={TOKEN} \
#     docker.io/grafana/mcp-grafana -t stdio

{ config, lib, pkgs, mkRootlessContainer, ... }:

let
  baseScrapes = [
    { job_name = "prometheus";
      static_configs = [ { targets = [ "prometheus:9090" ]; } ]; }

    { job_name = "node_exporter";
      static_configs = [ { targets = [ "host.containers.internal:9100" ]; } ]; }

    { job_name = "cadvisor";
      static_configs = [ { targets = [ "cadvisor:8080" ]; } ]; }
  ];

  # JSON is a YAML 1.1 superset — toJSON sidesteps quoting/escape pitfalls.
  prometheusConfig = pkgs.writeText "prometheus.yml" (builtins.toJSON {
    global = {
      scrape_interval = "15s";
      evaluation_interval = "15s";
    };
    scrape_configs = baseScrapes ++ config.myStack.prometheusScrapes;
  });

  # /etc/prometheus must be a dir (rule files land there too). Single
  # generated yml wrapped in a dir so alert_rules.yml can be added later
  # as a one-line extension.
  prometheusDir = pkgs.runCommand "prometheus-etc" { } ''
    mkdir -p $out
    cp ${prometheusConfig} $out/prometheus.yml
  '';

  # Three sources merged into one /nix/store dir mounted into grafana:
  #   1. Static JSON under ./assets/dashboards/         (root)
  #   2. myStack.grafanaDashboards                       (root)
  #   3. myStack.grafanaDashboardsByFolder               (subdirs ↔ sidebar folders)
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
  # grafana admin credentials: sops-encrypted env.sops, decrypted to
  # /run/secrets/grafana-env at activation. Edit with `sops env.sops`.
  sops.secrets."grafana-env" = {
    sopsFile = ./env.sops;
    format   = "dotenv";
    key      = "";
    owner    = "santiago";
  };

  myStack.containerNetworks = {
    prometheus    = "monitoring";
    grafana       = "monitoring";
    cadvisor      = "monitoring";
    node-exporter = null;        # host net — see comment on container below
  };

  myStack.webApps = {
    prometheus = {
      hostname = "prometheus.toscanini.me";
      serviceName = "prometheus";
      port = 9090;
    };
    grafana = {
      hostname = "grafana.toscanini.me";
      serviceName = "grafana";
      port = 3000;
    };
  };

  myStack.homepageServices."Monitoring" = [
    {
      name = "Grafana";
      href = "https://grafana.toscanini.me/bookmarks";
      description = "Dashboards (prometheus + loki)";
      icon = "grafana.png";
      siteMonitor = "http://grafana:3000";
      widget = {
        type = "grafana";
        version = 2;
        url = "http://grafana:3000";
        username = "{{HOMEPAGE_VAR_GRAFANA_USER}}";
        password = "{{HOMEPAGE_VAR_GRAFANA_PASS}}";
      };
    }
    {
      name = "Prometheus";
      href = "https://prometheus.toscanini.me";
      description = "TSDB — 30d / 100GB retention";
      icon = "prometheus.png";
      siteMonitor = "http://prometheus:9090";
      widget = {
        type = "prometheus";
        url = "http://prometheus:9090";
      };
    }
  ];

  virtualisation.oci-containers.containers.prometheus = mkRootlessContainer {
    image = "docker.io/prom/prometheus:v3.13.1";

    # Host port kept for external scrapers / remote_write / federation
    # (raw API access — bridge-routing via traefik would lose that).
    ports = [ "9090:9090" ];

    cmd = [
      "--config.file=/etc/prometheus/prometheus.yml"
      "--storage.tsdb.path=/prometheus"
      "--web.enable-lifecycle"
      "--storage.tsdb.retention.time=30d"
      "--storage.tsdb.retention.size=100GB"
    ];

    volumes = [
      "${prometheusDir}:/etc/prometheus:ro"
      "/home/santiago/selfhost/monitoring/prometheus/data:/prometheus"
    ];

    extraOptions = [
      # Image's default `nobody` (UID 65534) → host 100533, owner of
      # nothing. Override to UID 0 → host santiago, who owns the data dir.
      "--user=0:0"
      "--network=monitoring-net"
      "--network=traefik-net"  # scrape migrated stacks + traefik dials by DNS
    ];
  };

  virtualisation.oci-containers.containers.grafana = mkRootlessContainer {
    image = "docker.io/grafana/grafana:12.4.5";
    dependsOn = [ "prometheus" ];

    volumes = [
      "/home/santiago/selfhost/monitoring/grafana/data:/var/lib/grafana"
      "/home/santiago/selfhost/monitoring/grafana/app/provisioning/datasources:/etc/grafana/provisioning/datasources:ro"
      "/home/santiago/selfhost/monitoring/grafana/app/provisioning/dashboards:/etc/grafana/provisioning/dashboards:ro"
      "/home/santiago/selfhost/monitoring/grafana/app/provisioning/alerting:/etc/grafana/provisioning/alerting:ro"
      "${dashboardsDir}:/var/lib/grafana/dashboards:ro"
    ];

    environment = {
      GF_USERS_ALLOW_SIGN_UP = "false";
      GF_SERVER_ROOT_URL = "https://grafana.toscanini.me";
      GF_SERVER_SERVE_FROM_SUB_PATH = "false";
    };

    # GF_SECURITY_ADMIN_USER + GF_SECURITY_ADMIN_PASSWORD.
    environmentFiles = [ config.sops.secrets."grafana-env".path ];

    extraOptions = [
      "--user=0:0"
      "--network=monitoring-net"
      "--network=traefik-net"
    ];
  };

  # node-exporter runs in the host netns so it sees the real `enp3s0`
  # and reports actual NIC traffic. Inside a bridge it would only see
  # a synthetic `eth0` with meaningless 0 traffic.
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
      "--network=host"
    ];
  };

  # No /var/lib/docker or /var/run mounts — the latter would overlay the
  # container's /run and hide /run/.containerenv that podman's crun
  # needs. cadvisor still reports cgroup-level container stats via the
  # /sys mount; per-container CPU/RAM works (less rich than the
  # docker-aware view that used to exist).
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
