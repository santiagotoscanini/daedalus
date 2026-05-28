# wireguard — wg-easy (WireGuard server + admin web UI).
#
# Ports:
#   - 51820/udp — WireGuard protocol. Host-firewall-opened
#     (allowedUDPPorts below); reach via s2.toscanini.me:51820.
#   - 51821/tcp — admin web UI; bridge-routed via traefik (no host port).
#
# Caps + sysctls:
#   - NET_ADMIN: lets wg-easy create wg0 inside the container's netns.
#   - NET_RAW: iptables-legacy raw sockets for netfilter state queries
#     (NET_ADMIN alone returns "Permission denied").
#   - net.ipv4.ip_forward: routing between wg0 and the container's eth0.
#   - net.ipv4.conf.all.src_valid_mark: WireGuard mark-based routing.
#
# `SYS_MODULE` is NOT needed — the wireguard kernel module is loaded
# on the host (boot.kernelModules below); container just needs
# /lib/modules read-only to find it.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.wireguard = "traefik";
  myStack.webApps.wireguard = {
    hostname = "wireguard.toscanini.me";
    serviceName = "wireguard";
    port = 51821;
  };

  # tv stack's gluetun adds the same modules; NixOS merges the lists.
  boot.kernelModules = [ "wireguard" "iptable_nat" "iptable_filter" ];

  networking.firewall.allowedUDPPorts = [ 51820 ];

  myStack.prometheusScrapes = [{
    job_name = "wireguard";
    metrics_path = "/metrics/prometheus";
    static_configs = [{ targets = [ "wireguard:51821" ]; }];
  }];

  myStack.homepageServices."Network" = [{
    name = "WireGuard";
    href = "https://wireguard.toscanini.me";
    description = "VPN admin (wg-easy v15+)";
    icon = "wireguard.png";
    siteMonitor = "http://wireguard:51821";
    widget = {
      type = "wgeasy";
      url = "http://wireguard:51821";
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
    ];

    volumes = [
      "/home/santiago/selfhost/wireguard:/etc/wireguard"
      # NixOS keeps kernel modules under /run/booted-system, not
      # /lib/modules. Belt-and-suspenders bind (the module is loaded).
      "/run/booted-system/kernel-modules/lib/modules:/lib/modules:ro"
    ];

    environment = {
      INIT_ENABLED = "true";
      INIT_HOST = "s2.toscanini.me";
      INIT_PORT = "51820";
      # Local pi-hole so wg-easy's *.toscanini.me resolves to LAN IPs.
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
      "--network=traefik-net"
    ];
  };
}
