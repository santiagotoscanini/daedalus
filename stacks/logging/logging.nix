# logging — centralized log aggregation: loki + alloy.
#
# Two rootless containers on the existing `monitoring-net` bridge
# (so grafana queries loki by name as `loki:3100`, same way it
# queries `prometheus:9090`).
#
#   - loki:  log database. Filesystem store under
#            /home/santiago/selfhost/logging/loki/data, 30-day
#            retention via compactor (matches prometheus retention).
#            Exposed on host :3100 and via traefik at
#            logging.toscanini.me for LAN debugging; grafana uses
#            the bridge URL `http://loki:3100` either way.
#
#   - alloy: log collector. Reads the host's systemd journal (the
#            ONE source — every rootless-podman system unit's
#            stdout/stderr is logged there by podman's default
#            --log-driver=journald, plus host services like pi-hole,
#            ddclient, smartd, fail2ban). Forwards to loki with
#            labels {unit, container, host, level}. No file scraping
#            today; add another `loki.source.file` to config.alloy
#            if a specific service stops writing to journald.
#
# Why journald-only as the source: every container + every host
# service on this box already writes to journald. Adding per-file
# scrapers is duplication that grows cardinality without value.
#
# Permission setup for journal reads:
#   - Host `santiago` is added to the `systemd-journal` group (see
#     users.users.santiago.extraGroups below). NixOS gives that
#     group `rx` ACL on /var/log/journal by default.
#   - Alloy container runs with `--user=0:0` (host santiago in
#     rootless) + `--group-add=keep-groups` to inherit santiago's
#     systemd-journal membership inside the container's userns.
#
# Why not run alloy on the host as a NixOS service: keeps the
# "everything in containers + declared in nix" pattern; the
# permission gymnastics above are the only cost.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks = {
    loki  = "monitoring";
    alloy = "monitoring";
  };

  # LAN-only HTTPS UI / API. Loki itself has no UI — grafana is the
  # UI — but having a stable hostname is handy for ad-hoc LogCLI
  # queries or `curl /ready` from a laptop.
  myStack.webApps.loki = {
    hostname = "logging.toscanini.me";
    port = 3100;
  };

  virtualisation.oci-containers.containers.loki = mkRootlessContainer {
    image = "docker.io/grafana/loki:3.4.1";

    ports = [ "3100:3100" ];

    cmd = [ "-config.file=/etc/loki/loki.yaml" ];

    volumes = [
      "/home/santiago/selfhost/logging/loki/app/loki.yaml:/etc/loki/loki.yaml:ro"
      "/home/santiago/selfhost/logging/loki/data:/loki"
    ];

    extraOptions = [
      # `--user=0:0` → host santiago (1000) under rootless. The data
      # dir is owned santiago:users, matches.
      "--user=0:0"
      "--network=monitoring-net"
    ];
  };

  virtualisation.oci-containers.containers.alloy = mkRootlessContainer {
    image = "docker.io/grafana/alloy:v1.5.1";
    dependsOn = [ "loki" ];

    cmd = [
      "run"
      "--server.http.listen-addr=0.0.0.0:12345"
      "--storage.path=/var/lib/alloy/data"
      "/etc/alloy/config.alloy"
    ];

    volumes = [
      "/home/santiago/selfhost/logging/alloy/app:/etc/alloy:ro"
      # Persistent journal lives at /var/log/journal; volatile (early-
      # boot, before /var is mounted) at /run/log/journal. Mount both
      # so logs from very early boot are picked up too.
      "/var/log/journal:/var/log/journal:ro"
      "/run/log/journal:/run/log/journal:ro"
      "/etc/machine-id:/etc/machine-id:ro"
      "/home/santiago/selfhost/logging/alloy/data:/var/lib/alloy/data"
    ];

    extraOptions = [
      "--user=0:0"
      # Inherit santiago's supplementary groups (notably
      # `systemd-journal`) into the container's user-ns, so the
      # in-container UID 0 (= host santiago) can read journal files
      # whose group is `systemd-journal`.
      "--group-add=keep-groups"
      "--network=monitoring-net"
    ];
  };

  # Required for `--group-add=keep-groups` above to grant journal
  # read access. NixOS sets a tmpfiles ACL granting r-x on
  # /var/log/journal to the `systemd-journal` group.
  users.users.santiago.extraGroups = [ "systemd-journal" ];
}
