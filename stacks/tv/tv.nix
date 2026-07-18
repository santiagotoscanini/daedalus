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
# WireGuard key: sops-encrypted (tv-wg0 below), bind-mounted over the
# wg0.conf path inside the /gluetun dir mount. ProtonVPN shows the
# private key ONCE at export — a lost key means a fresh export, not
# recovery. The current key EXPIRES 2027-04-03 (reminder emails fire
# 30/7 days ahead). Renewal: re-export from
# https://account.protonvpn.com/downloads, then
#   sops -e --input-type binary --output-type binary wg0.conf \
#     > stacks/tv/wg0.conf.sops
# and bump the reminder dates below.

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  gluetunImage,
  mkGluetunExporter,
  ...
}:

let
  # Netns-tenant decorator: linuxserver s6 maps container root to host
  # santiago under rootless podman, so PUID/PGID=0 means "run as the
  # user that owns the data" (non-linuxserver tenants ignore the vars).
  # Every tenant depends on the netns owner and rides
  # --network=container:gluetun.
  mkNetnsTenant =
    args:
    mkRootlessContainer (
      args
      // {
        dependsOn = [ "gluetun" ];
        environment = {
          PUID = "0";
          PGID = "0";
        }
        // (args.environment or { });
        extraOptions = [ "--network=container:gluetun" ] ++ (args.extraOptions or [ ]);
      }
    );

  # Containers sharing gluetun's netns (no bridge of their own).
  netnsTenants = [
    "qbittorrent"
    "nzbget"
    "flaresolverr"
    "prowlarr"
    "radarr"
    "sonarr"
    "bazarr"
    "gluetun-exporter"
    "subgen"
  ];

  # gluetun-published web UIs — one entry per service, generating the
  # port publish on gluetun, the webApp (traefik dials the host port
  # via host.containers.internal), and the homepage tile. A LIST, not
  # an attrset: the order fixes gluetun's ports block, and reordering
  # would change podman-gluetun's ExecStart → gluetun recreate → every
  # netns tenant needs a manual restart.
  vpnUis = [
    {
      name = "qbittorrent";
      port = 8090;
      authBypassRule = "PathPrefix(`/api`)";
      homepage = {
        group = "Media";
        name = "qBittorrent";
        description = "BitTorrent (via gluetun/ProtonVPN)";
        icon = "qbittorrent.png";
        widget = {
          # Direct host.containers.internal:8090 returns 403 to homepage's
          # widget (CSRF / SameSite cookie). Go through traefik.
          type = "qbittorrent";
          url = "https://qbittorrent.toscanini.me";
          username = "{{HOMEPAGE_VAR_QBT_USER}}";
          password = "{{HOMEPAGE_VAR_QBT_PASS}}";
          enableLeechProgress = true;
        };
      };
    }
    {
      name = "nzbget";
      port = 6789;
      authBypassRule = "PathPrefix(`/jsonrpc`)";
      homepage = {
        group = "Media";
        name = "NZBGet";
        description = "Usenet downloader (via gluetun)";
        icon = "nzbget.png";
        # undici Connection: close bug — probe + widget through traefik.
        siteMonitor = "https://nzbget.toscanini.me";
        widget = {
          type = "nzbget";
          url = "https://nzbget.toscanini.me";
          # No creds: auth disabled (AUTH.md) — env password removed,
          # ControlPassword blanked, so the API is open (LAN-closed +
          # behind the Pocket ID gate).
        };
      };
    }
    {
      name = "prowlarr";
      port = 9696;
      authBypassRule = "HeaderRegexp(`X-Api-Key`, `.+`) || PathPrefix(`/api`) || PathPrefix(`/feed`) || PathPrefix(`/ping`)";
      homepage = {
        group = "Media";
        name = "Prowlarr";
        description = "Indexer aggregator";
        icon = "prowlarr.png";
        widget = {
          type = "prowlarr";
          url = "http://host.containers.internal:9696";
          key = "{{HOMEPAGE_VAR_PROWLARR_API_KEY}}";
        };
      };
    }
    {
      name = "radarr";
      port = 7878;
      authBypassRule = "HeaderRegexp(`X-Api-Key`, `.+`) || PathPrefix(`/api`) || PathPrefix(`/feed`) || PathPrefix(`/ping`)";
      homepage = {
        group = "Media";
        name = "Radarr";
        description = "Movies";
        icon = "radarr.png";
        widget = {
          type = "radarr";
          url = "http://host.containers.internal:7878";
          key = "{{HOMEPAGE_VAR_RADARR_API_KEY}}";
          enableQueue = true;
        };
      };
    }
    {
      name = "sonarr";
      port = 8989;
      authBypassRule = "HeaderRegexp(`X-Api-Key`, `.+`) || PathPrefix(`/api`) || PathPrefix(`/feed`) || PathPrefix(`/ping`)";
      homepage = {
        group = "Media";
        name = "Sonarr";
        description = "TV shows";
        icon = "sonarr.png";
        widget = {
          type = "sonarr";
          url = "http://host.containers.internal:8989";
          key = "{{HOMEPAGE_VAR_SONARR_API_KEY}}";
          enableQueue = true;
        };
      };
    }
    {
      name = "bazarr";
      port = 6767;
      authBypassRule = "HeaderRegexp(`X-Api-Key`, `.+`) || PathPrefix(`/api`) || PathPrefix(`/feed`) || PathPrefix(`/ping`)";
      homepage = {
        group = "Media";
        name = "Bazarr";
        description = "Subtitles";
        icon = "bazarr.png";
        widget = {
          type = "bazarr";
          url = "http://host.containers.internal:6767";
          key = "{{HOMEPAGE_VAR_BAZARR_API_KEY}}";
        };
      };
    }
  ];
in
{
  # ProtonVPN WireGuard config for gluetun — sops-encrypted and IN THE
  # REBUILD TRAIL (ProtonVPN shows the private key only once, at
  # export time). Bind-mounted over the wg0.conf
  # path inside the /gluetun dir mount.
  sops.secrets."tv-wg0" = {
    sopsFile = ./wg0.conf.sops;
    format = "binary";
    owner = "santiago";
  };

  # The key expires 2027-04-03 and the tunnel then dies silently (all
  # *arr/torrent egress stops). Renewal runbook in the header.
  systemd.services.tv-wg-expiry-reminder = {
    description = "Reminder: TV ProtonVPN WireGuard key expires 2027-04-03";
    serviceConfig.Type = "oneshot";
    script = ''
      {
        echo "From: ${config.myStack.mail.sender}"
        echo "To: ${config.myStack.mail.alertTo}"
        echo "Subject: [s2-server] TV VPN WireGuard key expires 2027-04-03"
        echo
        echo "The ProtonVPN WireGuard key for the TV stack (gluetun) expires 2027-04-03."
        echo "Renewal runbook: header of /etc/nixos/stacks/tv/tv.nix."
      } | ${pkgs.msmtp}/bin/msmtp --account=default -t
    '';
  };
  systemd.timers.tv-wg-expiry-reminder = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = [
        "2027-03-04" # 30 days out
        "2027-03-27" # 7 days out
      ];
      Persistent = true; # fire on next boot if the box was off
    };
  };


  # gluetun owns the netns; tenants have no bridge (null = pasta shape,
  # which here just earns the Type=oneshot systemd override). Jellyfin
  # is bridge-routed (outside the VPN).
  myStack.containerNetworks =
    lib.listToAttrs (map (n: lib.nameValuePair n null) ([ "gluetun" ] ++ netnsTenants))
    // {
      jellyfin = "traefik";
    };

  # Jellyfin is bridge-routed. The gluetun-netns UIs (from vpnUis) use
  # explicit serviceUrl pointing at gluetun's host-published ports —
  # putting gluetun on traefik-net would mix VPN-exit and bridge traffic.
  myStack.webApps =
    lib.listToAttrs (
      map (
        u:
        lib.nameValuePair u.name (
          {
            inherit (u) port homepage;
            serviceUrl = "http://host.containers.internal:${toString u.port}";
            # Pocket ID gate (AUTH.md). Each app's own login is disabled
            # (arrs: AuthenticationMethod=External; qbt: subnet whitelist;
            # nzbget: no password; bazarr: auth type null), so the gate
            # is the sole browser auth. authBypassRule lets machine
            # callers (seerr, prowlarr<->arr sync, recyclarr, homepage
            # widgets) through by their own API key / RPC path — they
            # can't do an OIDC redirect.
            auth = "oidc";
          }
          // lib.optionalAttrs (u ? authBypassRule) { inherit (u) authBypassRule; }
        )
      ) vpnUis
    )
    // {
      jellyfin = {
        serviceName = "jellyfin";
        port = 8096;
        homepage = {
          group = "Media";
          name = "Jellyfin";
          description = "Movies, TV, music — household media server";
          icon = "jellyfin.png";
          widget = {
            type = "jellyfin";
            url = "http://jellyfin:8096";
            key = "{{HOMEPAGE_VAR_JELLYFIN_API_KEY}}";
            enableBlocks = true;
            enableNowPlaying = true;
            enableUser = false;
          };
        };
      };
    };

  # wireguard.nix also declares wireguard/iptables modules; NixOS
  # merges the lists. `tun` is exclusive to gluetun (/dev/net/tun).
  boot.kernelModules = [
    "wireguard"
    "iptable_nat"
    "iptable_filter"
    "tun"
  ];

  myStack.prometheusScrapes = [
    {
      job_name = "gluetun";
      static_configs = [ { targets = [ "host.containers.internal:8001" ]; } ];
    }
  ];

  myStack.homepageServices."Network" = [
    {
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
    }
  ];

  virtualisation.oci-containers.containers.gluetun = mkRootlessContainer {
    image = gluetunImage;

    # Ports for all containers sharing gluetun's netns — the web UIs
    # come from vpnUis (in order). None of these are opened in the host
    # firewall — traefik dials them via host.containers.internal.
    #
    # Not published: 8191 (flaresolverr — internal to prowlarr only);
    # 6881 (qbittorrent BT — actual P2P comes through the tunnel, not
    # the host port); 8388/8888 (gluetun's built-in shadowsocks/http
    # proxy, unused).
    ports = map (u: "${toString u.port}:${toString u.port}") vpnUis ++ [
      "8001:8001" # gluetun-exporter (shares this netns)
      "8000:8000" # gluetun HTTP control server
      "9000:9000" # subgen (Bazarr uses /asr on localhost; OpenAI /v1 for litellm)
    ];

    volumes = [
      "/home/santiago/selfhost/tv/gluetun:/gluetun"
      "${config.sops.secrets."tv-wg0".path}:/gluetun/wireguard/wg0.conf:ro"
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

  virtualisation.oci-containers.containers.qbittorrent = mkNetnsTenant {
    image = "docker.io/linuxserver/qbittorrent:5.2.3_v2.0.13-ls468@sha256:352371a7242e8b4aa10958ca02076d1023758070519b89a10251475fb9f1a35a";

    volumes = [
      "/home/santiago/selfhost/tv/qbittorrent:/config"
      "/s2/tv/downloads/qbittorrent:/downloads"
      "/s2/tv/torrents:/data/torrents:rw"
    ];

    environment.WEBUI_PORT = "8090";
  };

  virtualisation.oci-containers.containers.nzbget = mkNetnsTenant {
    image = "docker.io/linuxserver/nzbget:v26.2-ls254@sha256:87eba87ec46982b003ab1f54cfabd962c5c5e95cb9eb2069cbec7b6370d0784b";

    volumes = [
      "/home/santiago/selfhost/tv/nzbget:/config"
      "/s2/tv/usenet:/data/usenet:rw"
    ];
  };

  # Internal CF-bypass API; only prowlarr calls it on 127.0.0.1:8191.
  virtualisation.oci-containers.containers.flaresolverr = mkNetnsTenant {
    image = "docker.io/flaresolverr/flaresolverr:v3.5.0@sha256:139dfee1c6f89249c8d665d1333a42e8ec74ec0a86bc6bb1c8461e10d3a66a47";

    environment = {
      LOG_LEVEL = "info";
      LOG_HTML = "false";
      CAPTCHA_SOLVER = "none";
    };
  };

  virtualisation.oci-containers.containers.prowlarr = mkNetnsTenant {
    image = "docker.io/linuxserver/prowlarr:2.4.0.5397-ls154@sha256:4fd7a166c8f46dd3370a871c250ee577d6c2ae97a0dbe0e3614b5ef736205620";

    volumes = [
      "/home/santiago/selfhost/tv/prowlarr:/config"
    ];
  };

  # /s2/tv (not /s2/tv/media) because radarr's "import from download
  # client" hardlinks across /downloads, /torrents, /media — all need
  # to be on the same filesystem under one bind mount.
  virtualisation.oci-containers.containers.radarr = mkNetnsTenant {
    image = "docker.io/linuxserver/radarr:6.3.0.10514-ls311@sha256:2b2c1c05eb3f648d2c80dfab9486147dd7bb0ad4d77fa972fc1c5de8f1da3738";

    volumes = [
      "/home/santiago/selfhost/tv/radarr:/config"
      "/s2/tv:/data"
    ];
  };

  virtualisation.oci-containers.containers.sonarr = mkNetnsTenant {
    image = "docker.io/linuxserver/sonarr:4.0.19.2979-ls320@sha256:24acea2956a0ccb11f103877d9f4f8576600fb34bff34820ed749c2256dab89f";

    volumes = [
      "/home/santiago/selfhost/tv/sonarr:/config"
      "/s2/tv:/data"
    ];
  };

  # bazarr only reads what the *arrs produce, so a narrower bind.
  virtualisation.oci-containers.containers.bazarr = mkNetnsTenant {
    image = "docker.io/linuxserver/bazarr:v1.6.0-ls355@sha256:4c30dc0bb9a5d223075e7f5d12c77bd293c4b460f86d696dbe64763104c1e88c";

    volumes = [
      "/home/santiago/selfhost/tv/bazarr:/config"
      "/s2/tv/media:/data/media"
    ];
  };

  # subgen — speech-to-text subtitle generation (Bazarr's whisperai
  # provider) + OpenAI-compatible STT for the platform. Dual API on
  # :9000: /asr (whisper-asr-webservice shape — Bazarr dials
  # 127.0.0.1:9000 inside the shared netns) and /v1/audio/
  # transcriptions|translations (OpenAI shape — published on gluetun's
  # port block so LiteLLM reaches it at host.containers.internal:9000).
  #
  # Plex/Jellyfin-webhook + folder-monitor features stay OFF — Bazarr
  # owns the subtitle pipeline (whisper is fallback-only). faster-
  # whisper "small" on CPU; first start downloads into the cache bind.
  systemd.tmpfiles.rules = [
    "d /home/santiago/selfhost/tv/subgen 0755 santiago users -"
  ];

  virtualisation.oci-containers.containers.subgen = mkNetnsTenant {
    image = "docker.io/mccloud/subgen:cpu@sha256:de40992da49bad8643e0795ec41739776b1e1c16af7684d7337aea98bb11c9cd";

    volumes = [
      "/home/santiago/selfhost/tv/subgen:/models"
    ];

    environment = {
      TRANSCRIBE_DEVICE = "cpu";
      WHISPER_MODEL = "small";
      # 2 workers: Bazarr's multi-minute episode jobs must not starve
      # short gateway calls (litellm health probe times out at 60s)
      CONCURRENT_TRANSCRIPTIONS = "2";
      MODEL_PATH = "/models";
      # keep the model resident (~1GB RAM) — default purges it 30s after
      # idle, making every next call pay a ~25s CPU reload
      MODEL_CLEANUP_DELAY = "86400";
      DEBUG = "False";
    };
  };

  # Prometheus metrics for the tunnel (platform/common.nix helper).
  virtualisation.oci-containers.containers.gluetun-exporter = mkGluetunExporter "gluetun";

  # Jellyfin runs outside gluetun (was looping LAN streaming through
  # ProtonVPN — slow, paid bandwidth). renderD128 = Intel Alder Lake
  # iGPU render node; mode 0666 on host so no `--group-add=render`
  # needed for rootless. i915 is force-loaded in configuration.nix.
  #
  # If LAN client auto-discovery is ever needed back, SSDP 1900 + 7359
  # have to land on host networking — multicast doesn't cross bridges.
  virtualisation.oci-containers.containers.jellyfin = mkRootlessContainer {
    image = "docker.io/linuxserver/jellyfin:10.11.11ubu2404-ls41@sha256:32aa0d4565c633db95af29a58e8a5dc9becdfa58564a3aea68436623fd45f5a1";

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
