# ipcrawl-vpn — a dedicated gluetun (ProtonVPN WireGuard) whose netns is
# borrowed by app-ipcrawl, so every outbound connection ipcrawl makes
# (camera live-probes + the daily Shodan pull) exits from ProtonVPN's IP,
# never the house's WAN IP. gluetun is fail-closed: if the tunnel drops its
# kill-switch blocks all egress, so a VPN outage can't leak the real IP —
# ipcrawl just loses internet until it recovers (the LAN UI keeps serving the
# local SQLite + screenshots).
#
# This is the same "gluetun trap" the TV stack lives with, standalone for
# ipcrawl:
#   - Only the netns owner (this container) may publish ports, so it publishes
#     ipcrawl's UI (host 3100 → in-netns 3000); traefik dials it via
#     host.containers.internal:3100 (see the app's `egress` in
#     stacks/apps/apps.nix + declarations.nix).
#   - app-ipcrawl joins with `--network=container:gluetun-ipcrawl` and thus
#     leaves traefik-net.
#
# Deliberately NOT reusing the TV stack's gluetun: same WireGuard key on two
# live tunnels conflicts, and it would mix ipcrawl traffic with the torrent
# VPN exit. This is a separate instance with its own ProtonVPN config.
#
# WireGuard config lives at
#   /home/santiago/selfhost/ipcrawl-vpn/gluetun/wireguard/wg0.conf
# placed imperatively (like tv/gluetun's) — NOT in the rebuild trail. ProtonVPN
# shows the private key once at export; re-export from
# account.protonvpn.com/downloads if lost. No VPN_PORT_FORWARDING — ipcrawl is
# outbound-only and needs no inbound forwarded port.

{ config, mkRootlessContainer, ... }:

{
  # ProtonVPN WireGuard config — sops-encrypted, in the rebuild trail
  # (separate ProtonVPN export from the TV stack's; same rationale).
  sops.secrets."ipcrawl-wg0" = {
    sopsFile = ./wg0.conf.sops;
    format   = "binary";
    owner    = "santiago";
  };

  # Register in containerNetworks with `null` (pasta, no bridge) so common.nix
  # gives it the mandatory Type=oneshot systemd override — without this the
  # container defaults to Type=notify, which is broken for rootless podman on
  # this box (podman run -d exits before READY). Same as the TV stack's
  # `gluetun = null`. The exporter shares gluetun's netns and needs the same.
  myStack.containerNetworks.gluetun-ipcrawl          = null;
  myStack.containerNetworks.gluetun-exporter-ipcrawl = null;

  # Prometheus scrapes the exporter by its own job so the Grafana panels can
  # tell this instance apart from the TV gluetun (job="gluetun"). Reached via
  # the host port gluetun-ipcrawl publishes for the exporter (8003 → :8001).
  myStack.prometheusScrapes = [{
    job_name = "gluetun-ipcrawl";
    static_configs = [{ targets = [ "host.containers.internal:8003" ]; }];
  }];

  # Homepage tile in the "Network" group, next to the TV gluetun. The native
  # gluetun widget reads the control API (public IP + region + country) — same
  # shape as stacks/tv/tv.nix, pointed at this instance's host :8002.
  myStack.homepageServices."Network" = [{
    name        = "Gluetun (ipcrawl)";
    href        = "https://ipcrawl.toscanini.me";
    description = "ProtonVPN WireGuard tunnel (netns egress for ipcrawl)";
    icon        = "gluetun.png";
    siteMonitor = "http://host.containers.internal:8002/v1/publicip/ip";
    widget = {
      type    = "gluetun";
      url     = "http://host.containers.internal:8002";
      version = 2;
    };
  }];

  # Host-loaded kernel modules gluetun needs (rootless can't load them). The
  # TV stack already declares these; NixOS merges the lists, so this is
  # belt-and-suspenders that keeps the stack self-contained if TV ever goes.
  boot.kernelModules = [ "wireguard" "iptable_nat" "iptable_filter" "tun" ];

  systemd.tmpfiles.rules = [
    "d /home/santiago/selfhost/ipcrawl-vpn                   0755 santiago users -"
    "d /home/santiago/selfhost/ipcrawl-vpn/gluetun           0755 santiago users -"
    "d /home/santiago/selfhost/ipcrawl-vpn/gluetun/wireguard 0700 santiago users -"
    # Must exist on the host so the config.toml file-mount below has a parent
    # inside the /gluetun dir mount.
    "d /home/santiago/selfhost/ipcrawl-vpn/gluetun/auth      0755 santiago users -"
  ];

  virtualisation.oci-containers.containers.gluetun-ipcrawl = mkRootlessContainer {
    image = "docker.io/qmcgaw/gluetun:latest";

    # host 3100 → ipcrawl UI (:3000 in-netns); traefik dials it via
    # host.containers.internal:3100. host 8002 → gluetun's control API
    # (:8000 in-netns) for the homepage widget — 8002 because the TV gluetun
    # already owns host :8000. Neither is opened in the host firewall; both
    # are LAN-only, reached via host.containers.internal.
    ports = [
      "3100:3000"
      "8002:8000"
      "8003:8001"   # gluetun-exporter (sibling in this netns) → Prometheus
    ];

    volumes = [
      "/home/santiago/selfhost/ipcrawl-vpn/gluetun:/gluetun"
      "${config.sops.secrets."ipcrawl-wg0".path}:/gluetun/wireguard/wg0.conf:ro"
      # Control-server auth policy (tracked asset, read-only from /nix/store —
      # so it's reproducible, unlike the TV stack's loose file). Without it,
      # gluetun's control API answers "Unauthorized" and the homepage widget
      # can't read the public IP.
      "${./assets/config.toml}:/gluetun/auth/config.toml:ro"
    ];

    environment = {
      VPN_SERVICE_PROVIDER = "custom";
      VPN_TYPE             = "wireguard";
    };

    extraOptions = [
      "--cap-add=NET_ADMIN"
      "--device=/dev/net/tun"
    ];
  };

  # Prometheus exporter for gluetun-ipcrawl — a sibling in the same netns that
  # polls the control API (localhost:8000, the readonly routes in config.toml)
  # and exposes gluetun_vpn_status / gluetun_vpn_infos / forwarded-port metrics
  # on :8001 (host-published as 8003 by gluetun-ipcrawl). Same image + shape as
  # the TV stack's gluetun-exporter.
  virtualisation.oci-containers.containers.gluetun-exporter-ipcrawl = mkRootlessContainer {
    image     = "ghcr.io/thecfu/gluetun-exporter:latest";
    dependsOn = [ "gluetun-ipcrawl" ];

    environment = {
      GLUETUN_URL       = "http://localhost:8000";
      EXPORTER_PORT     = "8001";
      EXPORTER_INTERVAL = "30";
    };

    extraOptions = [ "--network=container:gluetun-ipcrawl" ];
  };
}
