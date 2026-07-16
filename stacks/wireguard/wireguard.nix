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

{ config, mkRootlessContainer, ... }:

{
  # wg-easy INIT_USERNAME + INIT_PASSWORD: sops-encrypted env.sops, decrypted to
  # /run/secrets/wireguard-env at activation. Edit with `sops env.sops`.
  sops.secrets."wireguard-env" = {
    sopsFile = ./env.sops;
    format = "dotenv";
    key = "";
    owner = "santiago";
  };

  myStack.containerNetworks.wireguard = "traefik";
  myStack.webApps.wireguard = {
    hostname = "wireguard.toscanini.me";
    serviceName = "wireguard";
    port = 51821;
  };

  # tv stack's gluetun adds the same modules; NixOS merges the lists.
  boot.kernelModules = [
    "wireguard"
    "iptable_nat"
    "iptable_filter"
  ];

  networking.firewall.allowedUDPPorts = [ 51820 ];

  myStack.prometheusScrapes = [
    {
      job_name = "wireguard";
      metrics_path = "/metrics/prometheus";
      static_configs = [ { targets = [ "wireguard:51821" ]; } ];
    }
  ];

  myStack.homepageServices."Network" = [
    {
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
    }
  ];

  virtualisation.oci-containers.containers.wireguard = mkRootlessContainer {
    image = "ghcr.io/wg-easy/wg-easy:15.3.0@sha256:93bbd593e07bab98d02807a28770ac87ab6c48818e319e68c1f66561feb99876";

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
      # Client DNS must be the wg0 address (10.8.0.1), NOT a host IP:
      # - 192.168.0.2 is unreachable from the container netns (pasta
      #   copies the host IP into the namespace; port 53 has no netns
      #   listener, so queries die with "connection refused").
      # - 169.254.1.2 (pasta host alias) IS reachable from the netns,
      #   but clients never send it through the tunnel: 169.254/16 is
      #   link-local and stays pinned to the physical interface on
      #   macOS/iOS, beating the tunnel /1 routes.
      # A PostUp DNAT hook (stored in wg-easy.db, NOT re-created on a
      # fresh init — re-add via admin UI > Hooks if bootstrapping!)
      # forwards 10.8.0.1:53 -> 169.254.1.2:53 -> host pi-hole.
      INIT_DNS = "10.8.0.1";
      DISABLE_IPV6 = "true";
    };

    # INIT_USERNAME + INIT_PASSWORD (admin web-UI credentials).
    environmentFiles = [
      config.sops.secrets."wireguard-env".path
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
