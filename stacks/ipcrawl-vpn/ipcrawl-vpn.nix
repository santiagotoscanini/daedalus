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
# WireGuard config: sops-encrypted (ipcrawl-wg0 below), bind-mounted over
# the wg0.conf path inside the /gluetun dir mount. ProtonVPN shows the
# private key once at export; re-export from account.protonvpn.com/downloads
# if lost. The current key EXPIRES 2027-07-14 (reminder emails fire 30/7
# days ahead): re-export, then
#   sops -e --input-type binary --output-type binary wg0.conf \
#     > stacks/ipcrawl-vpn/wg0.conf.sops
# and bump the reminder dates below. No VPN_PORT_FORWARDING — ipcrawl is
# outbound-only and needs no inbound forwarded port.
#
# Host-port convention: the TV gluetun owns 8000 (control) + 8001
# (exporter); this instance publishes the same in-netns ports at +2
# (8002/8003). A third gluetun instance would take 8004/8005.

{
  config,
  pkgs,
  mkRootlessContainer,
  gluetunImage,
  mkGluetunExporter,
  ...
}:

{
  # ProtonVPN WireGuard config — sops-encrypted, in the rebuild trail
  # (separate ProtonVPN export from the TV stack's; same rationale).
  sops.secrets."ipcrawl-wg0" = {
    sopsFile = ./wg0.conf.sops;
    format = "binary";
    owner = "santiago";
  };

  # The key expires 2027-07-14; gluetun is fail-closed, so ipcrawl just
  # loses egress (camera probes + Shodan pulls stop). Runbook in header.
  systemd.services.ipcrawl-wg-expiry-reminder = {
    description = "Reminder: ipcrawl ProtonVPN WireGuard key expires 2027-07-14";
    serviceConfig.Type = "oneshot";
    script = ''
      {
        echo "From: ${config.myStack.mail.sender}"
        echo "To: ${config.myStack.mail.alertTo}"
        echo "Subject: [s2-server] ipcrawl VPN WireGuard key expires 2027-07-14"
        echo
        echo "The ProtonVPN WireGuard key for ipcrawl-vpn (gluetun-ipcrawl) expires 2027-07-14."
        echo "Renewal runbook: header of /etc/nixos/stacks/ipcrawl-vpn/ipcrawl-vpn.nix."
      } | ${pkgs.msmtp}/bin/msmtp --account=default -t
    '';
  };
  systemd.timers.ipcrawl-wg-expiry-reminder = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = [
        "2027-06-14" # 30 days out
        "2027-07-07" # 7 days out
      ];
      Persistent = true; # fire on next boot if the box was off
    };
  };

  # Register in containerNetworks with `null` (pasta, no bridge) so common.nix
  # gives it the mandatory Type=oneshot systemd override — without this the
  # container defaults to Type=notify, which is broken for rootless podman on
  # this box (podman run -d exits before READY). Same as the TV stack's
  # `gluetun = null`. The exporter shares gluetun's netns and needs the same.
  myStack.containerNetworks.gluetun-ipcrawl = [ ];
  myStack.containerNetworks.gluetun-exporter-ipcrawl = [ ];

  # Prometheus scrapes the exporter by its own job so the Grafana panels can
  # tell this instance apart from the TV gluetun (job="gluetun"). Reached via
  # the host port gluetun-ipcrawl publishes for the exporter (8003 → :8001).
  myStack.prometheusScrapes = [
    {
      job_name = "gluetun-ipcrawl";
      static_configs = [ { targets = [ "host.containers.internal:8003" ]; } ];
    }
  ];

  # Homepage tile in the "Network" group, next to the TV gluetun. The native
  # gluetun widget reads the control API (public IP + region + country) — same
  # shape as stacks/tv/tv.nix, pointed at this instance's host :8002.
  myStack.homepageServices."Network" = [
    {
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
    }
  ];

  # Host-loaded kernel modules gluetun needs (rootless can't load them). The
  # TV stack already declares these; NixOS merges the lists, so this is
  # belt-and-suspenders that keeps the stack self-contained if TV ever goes.
  boot.kernelModules = [
    "wireguard"
    "iptable_nat"
    "iptable_filter"
    "tun"
  ];

  systemd.tmpfiles.rules = [
    "d /home/santiago/selfhost/ipcrawl-vpn                   0755 santiago users -"
    "d /home/santiago/selfhost/ipcrawl-vpn/gluetun           0755 santiago users -"
    "d /home/santiago/selfhost/ipcrawl-vpn/gluetun/wireguard 0700 santiago users -"
    # Must exist on the host so the config.toml file-mount below has a parent
    # inside the /gluetun dir mount.
    "d /home/santiago/selfhost/ipcrawl-vpn/gluetun/auth      0755 santiago users -"
  ];

  virtualisation.oci-containers.containers.gluetun-ipcrawl = mkRootlessContainer {
    image = gluetunImage;

    # host 3100 → ipcrawl UI (:3000 in-netns); traefik dials it via
    # host.containers.internal:3100. host 8002 → gluetun's control API
    # (:8000 in-netns) for the homepage widget — 8002 because the TV gluetun
    # already owns host :8000. Neither is opened in the host firewall; both
    # are LAN-only, reached via host.containers.internal.
    ports = [
      "3100:3000"
      "8002:8000"
      "8003:8001" # gluetun-exporter (sibling in this netns) → Prometheus
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
      VPN_TYPE = "wireguard";
    };

    extraOptions = [
      "--cap-add=NET_ADMIN"
      "--device=/dev/net/tun"
    ];
  };

  # Prometheus metrics for this tunnel (platform/common.nix helper);
  # :8001 in-netns, host-published as 8003 by gluetun-ipcrawl.
  virtualisation.oci-containers.containers.gluetun-exporter-ipcrawl = mkGluetunExporter "gluetun-ipcrawl";
}
