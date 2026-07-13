# logging — centralized log aggregation: loki + alloy.
#
# Two containers on monitoring-net (grafana queries loki by name on
# the same bridge it queries prometheus).
#
#   - loki:  log DB. Filesystem store under
#            /home/santiago/selfhost/logging/loki/data, 30-day retention
#            (matches prometheus). Bridge-routed via traefik for LAN
#            debugging; grafana uses `http://loki:3100` directly.
#
#   - alloy: log collector. Reads the host's systemd journal — the ONE
#            source (every rootless-podman unit's stdout/stderr lands
#            there via --log-driver=journald, plus pi-hole/ddclient/
#            smartd/fail2ban). Forwards to loki with labels
#            {unit, container, host, level}. Add `loki.source.file`
#            to config.alloy if a specific service stops journald.
#
# Why alloy in a container (not as a native NixOS service): keeps the
# "everything in containers + declared in nix" pattern uniform across
# the fleet; the journal-permission gymnastics below are the only cost.
#
# Journal read permissions:
#   - santiago is in the `systemd-journal` group (extraGroups below);
#     NixOS grants that group `rx` ACL on /var/log/journal.
#   - Alloy container: `--user=0:0` (host santiago) +
#     `--group-add=keep-groups` to inherit santiago's supplementary
#     groups (notably systemd-journal) inside its userns.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks = {
    loki  = "monitoring";
    alloy = "monitoring";
  };

  # LAN-only stable hostname for ad-hoc LogCLI queries / `curl /ready`.
  # Loki has no UI of its own (grafana is the UI), but the route is handy.
  myStack.webApps.loki = {
    hostname = "logging.toscanini.me";
    serviceName = "loki";
    port = 3100;
  };

  virtualisation.oci-containers.containers.loki = mkRootlessContainer {
    image = "docker.io/grafana/loki:3.7.3";

    cmd = [ "-config.file=/etc/loki/loki.yaml" ];

    volumes = [
      "/home/santiago/selfhost/logging/loki/app/loki.yaml:/etc/loki/loki.yaml:ro"
      "/home/santiago/selfhost/logging/loki/data:/loki"
    ];

    extraOptions = [
      "--user=0:0"             # → host santiago, owns the data dir
      "--network=monitoring-net"
      "--network=traefik-net"  # traefik upstream
    ];
  };

  virtualisation.oci-containers.containers.alloy = mkRootlessContainer {
    image = "docker.io/grafana/alloy:v1.17.1";
    dependsOn = [ "loki" ];

    cmd = [
      "run"
      "--server.http.listen-addr=0.0.0.0:12345"
      "--storage.path=/var/lib/alloy/data"
      "/etc/alloy/config.alloy"
    ];

    volumes = [
      "/home/santiago/selfhost/logging/alloy/app:/etc/alloy:ro"
      # Persistent + volatile (early-boot) journal paths.
      "/var/log/journal:/var/log/journal:ro"
      "/run/log/journal:/run/log/journal:ro"
      "/etc/machine-id:/etc/machine-id:ro"
      "/home/santiago/selfhost/logging/alloy/data:/var/lib/alloy/data"
    ];

    extraOptions = [
      "--user=0:0"
      "--group-add=keep-groups"  # inherit systemd-journal in userns
      "--network=monitoring-net"
    ];
  };

  # Required for `--group-add=keep-groups` to grant journal access.
  users.users.santiago.extraGroups = [ "systemd-journal" ];
}
