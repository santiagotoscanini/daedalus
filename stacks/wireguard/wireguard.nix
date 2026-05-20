# wireguard — wg-easy (WireGuard server + admin web UI).
#
# Ports:
#   - 51820/udp — WireGuard protocol (open via the host firewall;
#     reach via s2.toscanini.me:51820 from outside).
#   - 51821/tcp — admin web UI on the host, NOT in the firewall;
#     Traefik dials it via host.containers.internal:51821 (route
#     registered via myStack.webApps.wireguard).
#
# `NET_ADMIN` lets wg-easy create the wg0 interface inside the
# container's netns. `SYS_MODULE` from the old compose is dropped —
# the wireguard kernel module is loaded on the host (boot.kernelModules
# below), so the container only needs /lib/modules read-only to find
# it. NET_RAW unlocks raw-socket access that iptables-legacy uses to
# query netfilter state (NET_ADMIN alone gets "Permission denied").
#
# The two sysctls live in the container's netns:
#   - net.ipv4.ip_forward: required so wg-easy can route between wg0
#     and the container's eth0 (pasta).
#   - net.ipv4.conf.all.src_valid_mark: required for the WireGuard
#     mark-based routing rules wg-easy installs.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.wireguard = null;
  myStack.webApps.wireguard = {
    hostname = "wireguard.toscanini.me";
    port = 51821;
  };

  # WireGuard kernel module + iptables-legacy tables that wg-quick
  # needs at runtime. Co-located here so removing the wg-easy container
  # also drops these (the tv stack's gluetun container adds the same
  # modules in modules/tv.nix; NixOS merges the lists).
  boot.kernelModules = [ "wireguard" "iptable_nat" "iptable_filter" ];

  networking.firewall.allowedUDPPorts = [ 51820 ];

  myStack.prometheusScrapes = [{
    job_name = "wireguard";
    metrics_path = "/metrics/prometheus";
    static_configs = [{ targets = [ "host.containers.internal:51821" ]; }];
  }];

  myStack.homepageServices."Network" = [{
    name = "WireGuard";
    href = "https://wireguard.toscanini.me";
    description = "VPN admin (wg-easy v15+)";
    icon = "wireguard.png";
    siteMonitor = "http://host.containers.internal:51821";
    widget = {
      type = "wgeasy";
      url = "http://host.containers.internal:51821";
      version = 2;
      username = "{{HOMEPAGE_VAR_WGEASY_USER}}";
      password = "{{HOMEPAGE_VAR_WGEASY_PASS}}";
      threshold = 2;
    };
  }];

  virtualisation.oci-containers.containers.wireguard = mkRootlessContainer {
    image = "ghcr.io/wg-easy/wg-easy:15";

    ports = [
      "51820:51820/udp"
      "51821:51821/tcp"
    ];

    volumes = [
      "/home/santiago/selfhost/wireguard:/etc/wireguard"
      # NixOS keeps kernel modules under /run/booted-system, not
      # /lib/modules. Bind-mount that as /lib/modules so wg-easy sees
      # the standard path. The module is already loaded at boot, so
      # this is mostly belt-and-suspenders.
      "/run/booted-system/kernel-modules/lib/modules:/lib/modules:ro"
    ];

    environment = {
      INIT_ENABLED = "true";
      INIT_HOST = "s2.toscanini.me";
      INIT_PORT = "51820";
      # Use the local pi-hole so wg-easy's *.toscanini.me lookups
      # resolve to LAN IPs.
      INIT_DNS = "192.168.0.2";
      DISABLE_IPV6 = "true";
    };

    # INIT_USERNAME + INIT_PASSWORD (admin web-UI credentials).
    environmentFiles = [
      "/etc/nixos/stacks/wireguard/secrets/env"
    ];

    extraOptions = [
      "--cap-add=NET_ADMIN"
      "--cap-add=NET_RAW"
      "--sysctl=net.ipv4.ip_forward=1"
      "--sysctl=net.ipv4.conf.all.src_valid_mark=1"
    ];
  };
}
