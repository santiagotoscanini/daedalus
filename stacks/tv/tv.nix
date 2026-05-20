# tv stack — media acquisition + library, VPN-anchored.
#
# Architecture:
#   - gluetun is the VPN anchor: holds a ProtonVPN WireGuard tunnel
#     and owns the netns that downloaders + *arrs share.
#   - The downloaders (qbittorrent, nzbget), the indexer (prowlarr),
#     the *arrs (radarr, sonarr, bazarr), the cf-bypass solver
#     (flaresolverr) and gluetun-exporter all run with
#     `--net=container:gluetun` so their egress goes through the VPN.
#   - Jellyfin runs OUTSIDE the VPN (pasta networking) so LAN streaming
#     to TVs/phones doesn't loop through ProtonVPN.
#
# Why all the published ports are declared on gluetun, not the
# dependents: containers that share a netns can't publish their own
# ports — only the netns owner can. So every UI port (qbittorrent
# 8090, sonarr 8989, etc.) is published in gluetun's block below.
#
# WireGuard config: /home/santiago/selfhost/tv/gluetun/wireguard/wg0.conf
# (ProtonVPN custom-WireGuard export, 1-year expiry — re-export from
# https://account.protonvpn.com/downloads when peers start failing).
# NB: ProtonVPN only shows the WireGuard private key ONCE at export
# time — if you lose wg0.conf or migrate to a new machine, you have
# to create a fresh export, not recover the key.

{ config, mkRootlessContainer, ... }:

{
  myStack.containerNetworks = {
    gluetun          = null;
    qbittorrent      = null;
    nzbget           = null;
    flaresolverr     = null;
    prowlarr         = null;
    radarr           = null;
    sonarr           = null;
    bazarr           = null;
    gluetun-exporter = null;   # shares gluetun's netns
    jellyfin         = null;
  };

  myStack.traefikRoutes = {
    jellyfin    = { host = "jellyfin.s2.toscanini.me";    port = 8096; };
    sonarr      = { host = "sonarr.s2.toscanini.me";      port = 8989; };
    radarr      = { host = "radarr.s2.toscanini.me";      port = 7878; };
    bazarr      = { host = "bazarr.s2.toscanini.me";      port = 6767; };
    prowlarr    = { host = "prowlarr.s2.toscanini.me";    port = 9696; };
    qbittorrent = { host = "qbittorrent.s2.toscanini.me"; port = 8090; };
    nzbget      = { host = "nzbget.s2.toscanini.me";      port = 6789; };
  };

  # Kernel modules gluetun needs at runtime. modules/wireguard.nix
  # also declares the wireguard/iptables ones; NixOS merges the lists.
  # tun is exclusive to gluetun (creates /dev/net/tun for the tunnel).
  boot.kernelModules = [ "wireguard" "iptable_nat" "iptable_filter" "tun" ];


  myStack.dnsHosts = [
    "192.168.0.2 jellyfin.s2.toscanini.me"
    "192.168.0.2 qbittorrent.s2.toscanini.me"
    "192.168.0.2 nzbget.s2.toscanini.me"
    "192.168.0.2 sonarr.s2.toscanini.me"
    "192.168.0.2 radarr.s2.toscanini.me"
    "192.168.0.2 bazarr.s2.toscanini.me"
    "192.168.0.2 prowlarr.s2.toscanini.me"
  ];

  myStack.prometheusScrapes = [{
    job_name = "gluetun";
    static_configs = [{ targets = [ "host.containers.internal:8001" ]; }];
  }];

  myStack.homepageServices."Media" = [
    {
      name = "Jellyfin";
      href = "https://jellyfin.s2.toscanini.me";
      description = "Movies, TV, music — household media server";
      icon = "jellyfin.png";
      siteMonitor = "http://host.containers.internal:8096";
      widget = {
        type = "jellyfin";
        url = "http://host.containers.internal:8096";
        key = "{{HOMEPAGE_VAR_JELLYFIN_API_KEY}}";
        enableBlocks = true;
        enableNowPlaying = true;
        enableUser = false;
      };
    }
    {
      name = "qBittorrent";
      href = "https://qbittorrent.s2.toscanini.me";
      description = "BitTorrent (via gluetun/ProtonVPN)";
      icon = "qbittorrent.png";
      siteMonitor = "http://host.containers.internal:8090";
      widget = {
        # Direct host.containers.internal:8090 makes qBittorrent
        # return 403 to homepage's widget (CSRF / SameSite cookie
        # interaction). Going through traefik fixes it.
        type = "qbittorrent";
        url = "https://qbittorrent.s2.toscanini.me";
        username = "{{HOMEPAGE_VAR_QBT_USER}}";
        password = "{{HOMEPAGE_VAR_QBT_PASS}}";
        enableLeechProgress = true;
      };
    }
    {
      name = "NZBGet";
      href = "https://nzbget.s2.toscanini.me";
      description = "Usenet downloader (via gluetun)";
      icon = "nzbget.png";
      siteMonitor = "https://nzbget.s2.toscanini.me";
      widget = {
        # `Connection: close` undici-bug workaround — go via traefik.
        type = "nzbget";
        url = "https://nzbget.s2.toscanini.me";
        username = "{{HOMEPAGE_VAR_NZBGET_USER}}";
        password = "{{HOMEPAGE_VAR_NZBGET_PASS}}";
      };
    }
    {
      name = "Sonarr";
      href = "https://sonarr.s2.toscanini.me";
      description = "TV shows";
      icon = "sonarr.png";
      siteMonitor = "http://host.containers.internal:8989";
      widget = {
        type = "sonarr";
        url = "http://host.containers.internal:8989";
        key = "{{HOMEPAGE_VAR_SONARR_API_KEY}}";
        enableQueue = true;
      };
    }
    {
      name = "Radarr";
      href = "https://radarr.s2.toscanini.me";
      description = "Movies";
      icon = "radarr.png";
      siteMonitor = "http://host.containers.internal:7878";
      widget = {
        type = "radarr";
        url = "http://host.containers.internal:7878";
        key = "{{HOMEPAGE_VAR_RADARR_API_KEY}}";
        enableQueue = true;
      };
    }
    {
      name = "Bazarr";
      href = "https://bazarr.s2.toscanini.me";
      description = "Subtitles";
      icon = "bazarr.png";
      siteMonitor = "http://host.containers.internal:6767";
      widget = {
        type = "bazarr";
        url = "http://host.containers.internal:6767";
        key = "{{HOMEPAGE_VAR_BAZARR_API_KEY}}";
      };
    }
    {
      name = "Prowlarr";
      href = "https://prowlarr.s2.toscanini.me";
      description = "Indexer aggregator";
      icon = "prowlarr.png";
      siteMonitor = "http://host.containers.internal:9696";
      widget = {
        type = "prowlarr";
        url = "http://host.containers.internal:9696";
        key = "{{HOMEPAGE_VAR_PROWLARR_API_KEY}}";
      };
    }
  ];

  myStack.homepageServices."Network" = [{
    name = "Gluetun";
    href = "https://qbittorrent.s2.toscanini.me";
    description = "ProtonVPN WireGuard tunnel (host netns for tv stack)";
    icon = "gluetun.png";
    siteMonitor = "http://host.containers.internal:8000/v1/publicip/ip";
    widget = {
      type = "gluetun";
      url = "http://host.containers.internal:8000";
      version = 2;
    };
  }];

  virtualisation.oci-containers.containers.gluetun = mkRootlessContainer {
    image = "docker.io/qmcgaw/gluetun:latest";

    ports = [
      # Ports for the containers that share gluetun's netns. None of
      # these are opened in the host firewall — Traefik dials them via
      # host.containers.internal:<port> for the UIs that get a route.
      "8090:8090"       # qbittorrent web UI
      "6789:6789"       # nzbget web UI
      "9696:9696"       # prowlarr web UI
      "7878:7878"       # radarr web UI
      "8989:8989"       # sonarr web UI
      "6767:6767"       # bazarr web UI
      "8001:8001"       # gluetun-exporter (shares this netns)
      "8000:8000"       # gluetun HTTP control server (homepage gluetun widget)
      # Notes on ports we DON'T publish:
      #   - 8191 (flaresolverr) — used only by prowlarr via 127.0.0.1
      #     inside the shared netns, no host access needed.
      #   - 6881 (qbittorrent BT) — the actual P2P traffic comes in
      #     through the VPN tunnel, not the host port.
      #   - 8388/8888 (gluetun's built-in shadowsocks/http proxy) —
      #     unused in this setup.
    ];

    volumes = [
      "/home/santiago/selfhost/tv/gluetun:/gluetun"
    ];

    environment = {
      VPN_SERVICE_PROVIDER = "custom";
      VPN_TYPE = "wireguard";
      VPN_PORT_FORWARDING = "on";
      VPN_PORT_FORWARDING_PROVIDER = "protonvpn";
      # Whenever ProtonVPN hands out a new forwarded port, push it to
      # qBittorrent's API so qBT listens on the matching port.
      # Requires "Bypass authentication for clients on localhost" in
      # qBT (set on first run). {{PORTS}} is gluetun's runtime
      # template.
      VPN_PORT_FORWARDING_UP_COMMAND = "/bin/sh -c 'wget -O- --retry-connrefused --post-data \"json={\\\"listen_port\\\":{{PORTS}}}\" http://127.0.0.1:8090/api/v2/app/setPreferences 2>&1'";
    };

    extraOptions = [
      "--cap-add=NET_ADMIN"
      "--device=/dev/net/tun"
    ];
  };

  # All of the netns-sharing dependents use the same shape:
  # PUID=0/PGID=0 (linuxserver s6-overlay maps container root to host
  # santiago in our rootless setup; UID=0 means "don't drop privs"),
  # `--network=container:gluetun`, and a /config + data-dir bind mount.

  virtualisation.oci-containers.containers.qbittorrent = mkRootlessContainer {
    image = "docker.io/linuxserver/qbittorrent:latest";
    dependsOn = [ "gluetun" ];

    volumes = [
      "/home/santiago/selfhost/tv/qbittorrent:/config"
      "/s2/tv/downloads/qbittorrent:/downloads"
      "/s2/tv/torrents:/data/torrents:rw"
    ];

    environment = {
      PUID = "0";
      PGID = "0";
      WEBUI_PORT = "8090";
    };

    extraOptions = [ "--network=container:gluetun" ];
  };

  virtualisation.oci-containers.containers.nzbget = mkRootlessContainer {
    image = "docker.io/linuxserver/nzbget:latest";
    dependsOn = [ "gluetun" ];

    volumes = [
      "/home/santiago/selfhost/tv/nzbget:/config"
      "/s2/tv/usenet:/data/usenet:rw"
    ];

    environment = {
      PUID = "0";
      PGID = "0";
    };

    # NZBGET_USER + NZBGET_PASS (admin credentials).
    environmentFiles = [ "/etc/nixos/stacks/tv/secrets/nzbget-env" ];

    extraOptions = [ "--network=container:gluetun" ];
  };

  # Internal API used by prowlarr to bypass Cloudflare protection. Not
  # routed through Traefik — only prowlarr calls it on 127.0.0.1:8191.
  virtualisation.oci-containers.containers.flaresolverr = mkRootlessContainer {
    image = "docker.io/flaresolverr/flaresolverr:latest";
    dependsOn = [ "gluetun" ];

    environment = {
      LOG_LEVEL = "info";
      LOG_HTML = "false";
      CAPTCHA_SOLVER = "none";
    };

    extraOptions = [ "--network=container:gluetun" ];
  };

  virtualisation.oci-containers.containers.prowlarr = mkRootlessContainer {
    image = "docker.io/linuxserver/prowlarr:latest";
    dependsOn = [ "gluetun" ];

    volumes = [
      "/home/santiago/selfhost/tv/prowlarr:/config"
    ];

    environment = {
      PUID = "0";
      PGID = "0";
    };

    extraOptions = [ "--network=container:gluetun" ];
  };

  # Bind-mounts /s2/tv (not just /s2/tv/media) because radarr's "import
  # from download client" workflow uses hardlinks across /downloads,
  # /torrents and /media — all must be on the same filesystem under
  # one bind mount.
  virtualisation.oci-containers.containers.radarr = mkRootlessContainer {
    image = "docker.io/linuxserver/radarr:latest";
    dependsOn = [ "gluetun" ];

    volumes = [
      "/home/santiago/selfhost/tv/radarr:/config"
      "/s2/tv:/data"
    ];

    environment = {
      PUID = "0";
      PGID = "0";
    };

    extraOptions = [ "--network=container:gluetun" ];
  };

  virtualisation.oci-containers.containers.sonarr = mkRootlessContainer {
    image = "docker.io/linuxserver/sonarr:latest";
    dependsOn = [ "gluetun" ];

    volumes = [
      "/home/santiago/selfhost/tv/sonarr:/config"
      "/s2/tv:/data"
    ];

    environment = {
      PUID = "0";
      PGID = "0";
    };

    extraOptions = [ "--network=container:gluetun" ];
  };

  # bazarr only needs /data/media (it reads what radarr/sonarr
  # produce), so a narrower bind mount than the *arrs.
  virtualisation.oci-containers.containers.bazarr = mkRootlessContainer {
    image = "docker.io/linuxserver/bazarr:latest";
    dependsOn = [ "gluetun" ];

    volumes = [
      "/home/santiago/selfhost/tv/bazarr:/config"
      "/s2/tv/media:/data/media"
    ];

    environment = {
      PUID = "0";
      PGID = "0";
    };

    extraOptions = [ "--network=container:gluetun" ];
  };

  # Reads gluetun's HTTP control server (localhost:8000 inside the
  # shared netns) and exports VPN state as Prometheus metrics on :8001.
  # Published port comes from gluetun's container block above (which
  # owns the netns).
  virtualisation.oci-containers.containers.gluetun-exporter = mkRootlessContainer {
    image = "ghcr.io/thecfu/gluetun-exporter:latest";
    dependsOn = [ "gluetun" ];

    environment = {
      GLUETUN_URL = "http://localhost:8000";
      EXPORTER_PORT = "8001";
      EXPORTER_INTERVAL = "30";
    };

    extraOptions = [ "--network=container:gluetun" ];
  };

  # Jellyfin is pulled OUT of gluetun's VPN namespace. The old compose
  # had `network_mode: service:gluetun` which meant LAN streaming
  # looped through the ProtonVPN exit node — slow and burning paid VPN
  # bandwidth. Standalone pasta means clients on the LAN reach
  # jellyfin directly via the host.
  #
  # Hardware transcoding: /dev/dri/renderD128 is the Intel Alder Lake
  # iGPU's render node, world-rw (mode 0666) on this host, so passing
  # it via --device is enough — no `--group-add=render` needed for
  # rootless. The i915 driver is force-loaded for this iGPU (see
  # boot.kernelParams in configuration.nix).
  #
  # The compose's `group_add: [303]` (render GID) is dropped: rootless
  # podman would map host GID 303 through santiago's subgid table, and
  # the mode 0666 on the device makes it irrelevant anyway.
  virtualisation.oci-containers.containers.jellyfin = mkRootlessContainer {
    image = "docker.io/linuxserver/jellyfin:latest";

    ports = [
      # Web UI — main port for clients. Traefik routes
      # jellyfin.s2.toscanini.me here.
      "8096:8096"
    ];

    volumes = [
      "/home/santiago/selfhost/tv/jellyfin:/config"
      "/s2/tv/media:/data"
    ];

    environment = {
      PUID = "0";
      PGID = "0";
    };

    extraOptions = [
      "--device=/dev/dri/renderD128"
    ];
  };
}
