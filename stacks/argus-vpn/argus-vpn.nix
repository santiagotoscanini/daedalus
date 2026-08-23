# argus-vpn — a dedicated gluetun (ProtonVPN WireGuard) whose netns is
# borrowed by app-argus, so every outbound connection argus makes
# (live probes + the daily index pull) exits from ProtonVPN's IP,
# never the house's WAN IP. gluetun is fail-closed: if the tunnel drops its
# kill-switch blocks all egress, so a VPN outage can't leak the real IP —
# argus just loses internet until it recovers (the LAN UI keeps serving the
# local catalogue + stored captures).
#
# This is the same "gluetun trap" the TV stack lives with, standalone for
# argus:
#   - Only the netns owner (this container) may publish ports, so it publishes
#     argus's UI (host 3100 → in-netns 3000); traefik dials it via
#     host.containers.internal:3100 (see the app's `egress` in
#     stacks/apps/apps.nix + declarations.nix).
#   - app-argus joins with `--network=container:gluetun-argus` and thus
#     leaves traefik-net.
#
# Deliberately NOT reusing the TV stack's gluetun: same WireGuard key on two
# live tunnels conflicts, and it would mix argus traffic with the torrent
# VPN exit. This is a separate instance with its own ProtonVPN config; the
# shared per-instance kit comes from platform/gluetun-lib.nix. No
# VPN_PORT_FORWARDING — argus is outbound-only.

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
      name = "gluetun-argus";
      secretName = "argus-wg0";
      wgConfSops = ./wg0.conf.sops;
      authConfig = ./assets/config.toml;
      # apps/argus, so the tunnel's state (<stateRoot>/gluetun) sits inside
      # the app's own dir beside data/ — mirroring tv/gluetun for the TV
      # tunnel. The gluetun dir contents are just servers.json + auth
      # config; nothing here is netns-identity the tunnel would miss.
      stateRoot = "${config.fleet.stateRoot}/apps/argus";
      keyExpiry = "2027-07-14";
      reminderDates = [
        "2027-06-14" # 30 days out
        "2027-07-07" # 7 days out
      ];
      reminderPrefix = "argus";
      subject = "Argus VPN (gluetun-argus)";
      runbookPath = "/etc/nixos/stacks/argus-vpn/argus-vpn.nix";

      # Host-port convention: the TV gluetun owns 8000 (control) + 8001
      # (exporter); this instance publishes the same in-netns ports at +2.
      # A third gluetun instance would take 8004/8005. None of these are
      # firewall-opened; all LAN-only via host.containers.internal.
      ports = [
        "3100:3000" # argus UI (traefik dials host.containers.internal:3100)
        "8002:8000" # gluetun control API
        "8003:8001" # gluetun-exporter → prometheus
      ];

      # job defaults to the instance name ("gluetun-argus"), distinct
      # from the TV gluetun's job="gluetun" for the Grafana panels.
      scrapeTarget = "host.containers.internal:8003";

      # Argus keeps its catalogue in the shared postgres cluster, and a
      # container in this netns has no bridge to reach `pg` on — it dials
      # the plain-TCP host port instead (`appDatabases.argus.reach =
      # "hostPort"`, derived from the app's `egress`). Without this the
      # kill switch drops that connection and the app boots to an empty
      # catalogue. Scanner traffic still exits through the tunnel.
      hostEgress = true;

    })
    {
      fleet.logStacks.argus-vpn = [
        "gluetun-argus"
        "gluetun-argus-exporter"
      ];

      fleet.statePaths."${config.fleet.stateRoot}/apps/argus" = { };
    }
  ];
}
