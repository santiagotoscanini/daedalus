# tv stack — media acquisition + library, VPN-anchored.
#
# Architecture:
#   - gluetun holds a ProtonVPN WireGuard tunnel and owns the netns.
#   - The downloaders (qbittorrent, nzbget), the indexer (prowlarr),
#     the *arrs (radarr, sonarr, bazarr), flaresolverr, and
#     gluetun-exporter all run with `--net=container:gluetun` so their
#     egress goes through the VPN. Only the netns owner (gluetun) can
#     publish ports — every UI port lives on gluetun's container block.
#   - Jellyfin is OUTSIDE the VPN (joins traefik-net) so LAN streaming
#     doesn't loop through ProtonVPN exit nodes.
#
# WireGuard config: /home/santiago/selfhost/tv/gluetun/wireguard/wg0.conf
# (ProtonVPN custom-WireGuard export, 1-year expiry — re-export from
# https://account.protonvpn.com/downloads when peers fail). ProtonVPN
# only shows the private key ONCE at export — if you lose this file,
# you must create a fresh export, not recover.

{ config, lib, mkRootlessContainer, ... }:

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
    jellyfin         = "traefik";
  };

  # Jellyfin is bridge-routed. The 6 gluetun-netns UIs use explicit
  # serviceUrl pointing at gluetun's host-published ports — putting
  # gluetun on traefik-net would mix VPN-exit and bridge traffic.
  myStack.webApps = {
    jellyfin = {
      hostname    = "jellyfin.toscanini.me";
      serviceName = "jellyfin";
      port        = 8096;
    };
    sonarr = {
      hostname   = "sonarr.toscanini.me";
      port       = 8989;
      serviceUrl = "http://host.containers.internal:8989";
    };
    radarr = {
      hostname   = "radarr.toscanini.me";
      port       = 7878;
      serviceUrl = "http://host.containers.internal:7878";
    };
    bazarr = {
      hostname   = "bazarr.toscanini.me";
      port       = 6767;
      serviceUrl = "http://host.containers.internal:6767";
    };
    prowlarr = {
      hostname   = "prowlarr.toscanini.me";
      port       = 9696;
      serviceUrl = "http://host.containers.internal:9696";
    };
    qbittorrent = {
      hostname   = "qbittorrent.toscanini.me";
      port       = 8090;
      serviceUrl = "http://host.containers.internal:8090";
    };
    nzbget = {
      hostname   = "nzbget.toscanini.me";
      port       = 6789;
      serviceUrl = "http://host.containers.internal:6789";
    };
  };

  # wireguard.nix also declares wireguard/iptables modules; NixOS
  # merges the lists. `tun` is exclusive to gluetun (/dev/net/tun).
  boot.kernelModules = [ "wireguard" "iptable_nat" "iptable_filter" "tun" ];

  myStack.prometheusScrapes = [{
    job_name = "gluetun";
    static_configs = [{ targets = [ "host.containers.internal:8001" ]; }];
  }];

  myStack.homepageServices."Media" = lib.mkMerge [
    (lib.mkOrder 400 [
    {
      name = "Jellyfin";
      href = "https://jellyfin.toscanini.me";
      description = "Movies, TV, music — household media server";
      icon = "jellyfin.png";
      siteMonitor = "http://jellyfin:8096";
      widget = {
        type = "jellyfin";
        url = "http://jellyfin:8096";
        key = "{{HOMEPAGE_VAR_JELLYFIN_API_KEY}}";
        enableBlocks = true;
        enableNowPlaying = true;
        enableUser = false;
      };
    }
    {
      name = "qBittorrent";
      href = "https://qbittorrent.toscanini.me";
      description = "BitTorrent (via gluetun/ProtonVPN)";
      icon = "qbittorrent.png";
      siteMonitor = "http://host.containers.internal:8090";
      widget = {
        # Direct host.containers.internal:8090 returns 403 to homepage's
        # widget (CSRF / SameSite cookie). Go through traefik.
        type = "qbittorrent";
        url = "https://qbittorrent.toscanini.me";
        username = "{{HOMEPAGE_VAR_QBT_USER}}";
        password = "{{HOMEPAGE_VAR_QBT_PASS}}";
        enableLeechProgress = true;
      };
    }
    {
      name = "NZBGet";
      href = "https://nzbget.toscanini.me";
      description = "Usenet downloader (via gluetun)";
      icon = "nzbget.png";
      siteMonitor = "https://nzbget.toscanini.me";
      widget = {
        # undici Connection: close bug — go through traefik.
        type = "nzbget";
        url = "https://nzbget.toscanini.me";
        username = "{{HOMEPAGE_VAR_NZBGET_USER}}";
        password = "{{HOMEPAGE_VAR_NZBGET_PASS}}";
      };
    }
    ])
    (lib.mkOrder 600 [
    {
      name = "Sonarr";
      href = "https://sonarr.toscanini.me";
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
      href = "https://radarr.toscanini.me";
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
      href = "https://bazarr.toscanini.me";
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
      href = "https://prowlarr.toscanini.me";
      description = "Indexer aggregator";
      icon = "prowlarr.png";
      siteMonitor = "http://host.containers.internal:9696";
      widget = {
        type = "prowlarr";
        url = "http://host.containers.internal:9696";
        key = "{{HOMEPAGE_VAR_PROWLARR_API_KEY}}";
      };
    }
    ])
  ];

  myStack.homepageServices."Network" = [{
    name = "Gluetun";
    href = "https://qbittorrent.toscanini.me";
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

    # Ports for all containers sharing gluetun's netns. None of these
    # are opened in the host firewall — traefik dials them via
    # host.containers.internal.
    #
    # Not published: 8191 (flaresolverr — internal to prowlarr only);
    # 6881 (qbittorrent BT — actual P2P comes through the tunnel, not
    # the host port); 8388/8888 (gluetun's built-in shadowsocks/http
    # proxy, unused).
    ports = [
      "8090:8090"       # qbittorrent web UI
      "6789:6789"       # nzbget web UI
      "9696:9696"       # prowlarr web UI
      "7878:7878"       # radarr web UI
      "8989:8989"       # sonarr web UI
      "6767:6767"       # bazarr web UI
      "8001:8001"       # gluetun-exporter (shares this netns)
      "8000:8000"       # gluetun HTTP control server
    ];

    volumes = [
      "/home/santiago/selfhost/tv/gluetun:/gluetun"
    ];

    environment = {
      VPN_SERVICE_PROVIDER = "custom";
      VPN_TYPE = "wireguard";
      VPN_PORT_FORWARDING = "on";
      VPN_PORT_FORWARDING_PROVIDER = "protonvpn";
      # When ProtonVPN hands out a new forwarded port, push it to
      # qBittorrent so qBT listens there. Requires "Bypass auth for
      # localhost clients" in qBT. {{PORTS}} is gluetun's template.
      VPN_PORT_FORWARDING_UP_COMMAND = "/bin/sh -c 'wget -O- --retry-connrefused --post-data \"json={\\\"listen_port\\\":{{PORTS}}}\" http://127.0.0.1:8090/api/v2/app/setPreferences 2>&1'";
    };

    extraOptions = [
      "--cap-add=NET_ADMIN"
      "--device=/dev/net/tun"
    ];
  };

  # Netns-sharing pattern: PUID=0/PGID=0 (linuxserver s6 maps container
  # root to host santiago in our rootless setup; UID=0 means "don't drop
  # privs"), `--network=container:gluetun`, /config + data binds.

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

  # Internal CF-bypass API; only prowlarr calls it on 127.0.0.1:8191.
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

  # /s2/tv (not /s2/tv/media) because radarr's "import from download
  # client" hardlinks across /downloads, /torrents, /media — all need
  # to be on the same filesystem under one bind mount.
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

  # bazarr only reads what the *arrs produce, so a narrower bind.
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

  # Reads gluetun's control server (localhost:8000 inside the shared
  # netns), exports as Prometheus metrics on :8001. The published port
  # lives on gluetun's block (netns owner).
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

  # Jellyfin runs outside gluetun (was looping LAN streaming through
  # ProtonVPN — slow, paid bandwidth). renderD128 = Intel Alder Lake
  # iGPU render node; mode 0666 on host so no `--group-add=render`
  # needed for rootless. i915 is force-loaded in configuration.nix.
  #
  # If LAN client auto-discovery is ever needed back, SSDP 1900 + 7359
  # have to land on host networking — multicast doesn't cross bridges.
  virtualisation.oci-containers.containers.jellyfin = mkRootlessContainer {
    image = "docker.io/linuxserver/jellyfin:latest";

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
      "--network=traefik-net"
    ];
  };
}
