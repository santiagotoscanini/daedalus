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
# VPN exit. This is a separate instance with its own ProtonVPN config; the
# shared per-instance kit comes from platform/gluetun-lib.nix. No
# VPN_PORT_FORWARDING — ipcrawl is outbound-only.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  ...
}:

let
  inherit
    (import ../../platform/gluetun-lib.nix {
      inherit
        config
        lib
        pkgs
        mkRootlessContainer
        ;
    })
    mkGluetunInstance
    ;
in
{
  config = lib.mkMerge [
    (mkGluetunInstance {
      name = "gluetun-ipcrawl";
      exporterName = "gluetun-exporter-ipcrawl";
      secretName = "ipcrawl-wg0";
      wgConfSops = ./wg0.conf.sops;
      authConfig = ./assets/config.toml;
      stateRoot = "/home/santiago/selfhost/ipcrawl-vpn";
      keyExpiry = "2027-07-14";
      reminderDates = [
        "2027-06-14" # 30 days out
        "2027-07-07" # 7 days out
      ];
      reminderPrefix = "ipcrawl";
      subject = "ipcrawl VPN (gluetun-ipcrawl)";
      runbookPath = "/etc/nixos/stacks/ipcrawl-vpn/ipcrawl-vpn.nix";

      # Host-port convention: the TV gluetun owns 8000 (control) + 8001
      # (exporter); this instance publishes the same in-netns ports at +2.
      # A third gluetun instance would take 8004/8005. None of these are
      # firewall-opened; all LAN-only via host.containers.internal.
      ports = [
        "3100:3000" # ipcrawl UI (traefik dials host.containers.internal:3100)
        "8002:8000" # gluetun control API (homepage widget)
        "8003:8001" # gluetun-exporter → prometheus
      ];

      # Distinct job so the Grafana panels can tell this instance apart
      # from the TV gluetun (job="gluetun").
      scrapeJob = "gluetun-ipcrawl";
      scrapeTarget = "host.containers.internal:8003";

      homepage = {
        name = "Gluetun (ipcrawl)";
        href = "https://ipcrawl.toscanini.me";
        description = "ProtonVPN WireGuard tunnel (netns egress for ipcrawl)";
        icon = "gluetun.png";
        siteMonitor = "http://host.containers.internal:8002/v1/publicip/ip";
        widget = {
          type = "gluetun";
          url = "http://host.containers.internal:8002";
          version = 2;
        };
      };
    })
    {
      fleet.logStacks.ipcrawl-vpn = [
        "gluetun-ipcrawl"
        "gluetun-exporter-ipcrawl"
      ];

      fleet.statePaths."/home/santiago/selfhost/ipcrawl-vpn" = { };
    }
  ];
}
