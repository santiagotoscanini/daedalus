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
# To wire local `claude` CLI to Grafana via MCP (replace {TOKEN} with a
# Grafana service-account token from
# https://grafana.s2.toscanini.me/org/serviceaccounts):
#
#   claude mcp add --transport stdio --scope user grafana -- \
#       podman run --rm -i \
#       -e GRAFANA_URL=https://grafana.s2.toscanini.me \
#       -e GRAFANA_SERVICE_ACCOUNT_TOKEN={TOKEN} \
#       docker.io/grafana/mcp-grafana -t stdio

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks = {
    prometheus    = "monitoring";
    grafana       = "monitoring";
    cadvisor      = "monitoring";
    node-exporter = null;        # host net (sees real enp3s0)
  };

  myStack.traefikRoutes = {
    prometheus = { host = "prometheus.s2.toscanini.me"; port = 9090; };
    grafana    = { host = "grafana.s2.toscanini.me";    port = 3000; };
  };

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
      # `prometheus.yml` and any alert rule files are edited on the
      # host — the prom/prometheus image is distroless (no shell, no
      # editor inside the container).
      "/home/santiago/selfhost/monitoring/prometheus/app:/etc/prometheus:ro"
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
      "/home/santiago/selfhost/monitoring/grafana/app/dashboards:/var/lib/grafana/dashboards:ro"
    ];

    environment = {
      GF_USERS_ALLOW_SIGN_UP = "false";
      GF_SERVER_ROOT_URL = "https://grafana.s2.toscanini.me";
      GF_SERVER_SERVE_FROM_SUB_PATH = "false";
    };

    # GF_SECURITY_ADMIN_USER + GF_SECURITY_ADMIN_PASSWORD.
    environmentFiles = [ "/etc/nixos/containers/monitoring/grafana.env" ];

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
