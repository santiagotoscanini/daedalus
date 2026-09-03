# wg-easy — WireGuard server + admin web UI.
#
# Ports:
#   - 51820/udp — WireGuard protocol. Host-firewall-opened
#     (allowedUDPPorts below); reach via fleet.wanHost:51820, which pi-hole
#     also answers with the LAN address — so a profile generated once works
#     both at home (straight to the box) and away, with no second endpoint.
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

{
  config,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

{
  # wg-easy INIT_USERNAME + INIT_PASSWORD: sops-encrypted env.sops, decrypted to
  # /run/secrets/wg-easy-env at activation. Edit with `sops env.sops`.
  sops.secrets."wg-easy-env" = mkDotenvSecret ./env.sops;

  fleet.bridgeMemberships.wg-easy = [ "traefik" ];
  fleet.webApps.wg-easy = {
    serviceName = "wg-easy";
    port = 51821;
    metrics = {
      enable = true;
      path = "/metrics/prometheus";
    };
  };

  # tv stack's gluetun adds the same modules; NixOS merges the lists.
  boot.kernelModules = [
    "wireguard"
    "iptable_nat"
    "iptable_filter"
  ];


  # The router forwards this port to the box — see fleet.directIngress. The
  # tunnel carries HTTP only, and WireGuard is UDP.
  fleet.directIngress.wireguard = {
    port = 51820;
    note = "A WireGuard socket does not answer an unauthenticated packet at all, which is the entire reason a forwarded port is acceptable here.";
  };

  networking.firewall.allowedUDPPorts = [ 51820 ];

  fleet.statePaths = {
    # Non-traversable parent closes the world-readable window if wg-easy
    # rewrites its db loosely; container root maps to santiago, so the
    # bind mount still works.
    "${config.fleet.stateRoot}/wg-easy".mode = "0700";
    # wg-easy writes wg-easy.db (server private key + client configs/PSKs)
    # world-readable (0644). state-paths re-tightens it to 0600 at boot —
    # a private key has no business being world-readable, even on a
    # single-user box. (tmpfiles can't do this: it silently skips rules
    # under the santiago-owned /home prefix. `f` pre-creates the file
    # empty if missing, which SQLite treats as a valid empty DB.)
    "${config.fleet.stateRoot}/wg-easy/wg-easy.db" = {
      type = "f";
      mode = "0600";
    };
  };

  virtualisation.oci-containers.containers.wg-easy = mkRootlessContainer {
    image = "ghcr.io/wg-easy/wg-easy:15.4.0@sha256:0e7bc9d34e86ddcaa92bc700d4d7dc9b33291dbc07ac8d13382f7c2095f949ec";

    ports = [
      "51820:51820/udp"
    ];

    volumes = [
      "${config.fleet.stateRoot}/wg-easy:/etc/wireguard"
      # NixOS keeps kernel modules under /run/booted-system, not
      # /lib/modules. Belt-and-suspenders bind (the module is loaded).
      "/run/booted-system/kernel-modules/lib/modules:/lib/modules:ro"
    ];

    environment = {
      INIT_ENABLED = "true";
      INIT_HOST = config.fleet.wanHost;
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
      config.sops.secrets."wg-easy-env".path
    ];

    extraOptions = [
      "--cap-add=NET_ADMIN"
      "--cap-add=NET_RAW"
      "--sysctl=net.ipv4.ip_forward=1"
      "--sysctl=net.ipv4.conf.all.src_valid_mark=1"
    ];
  };
}
