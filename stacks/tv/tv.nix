# tv stack — media acquisition + library, VPN-anchored.
#
# Architecture:
#   - gluetun holds a ProtonVPN WireGuard tunnel and owns the netns.
#   - The downloaders (qbittorrent, nzbget), the indexer (prowlarr),
#     the *arrs (radarr, sonarr, bazarr), flaresolverr, subgen, and
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

  # Shared auth-bypass rule for the *arrs (Servarr apps expose the same
  # API surface): API-key callers, /api, RSS /feed, and /ping skip the
  # Pocket ID gate.
  arrApiBypass = "HeaderRegexp(`X-Api-Key`, `.+`) || PathPrefix(`/api`) || PathPrefix(`/feed`) || PathPrefix(`/ping`)";

  # gluetun-published web UIs — one entry per service; mkGluetunInstance
  # turns each into a Pocket-ID-gated webApp (AUTH.md: every app's own
  # login is disabled — arrs: AuthenticationMethod=External; qbt: subnet
  # whitelist; nzbget: no password; bazarr: auth type null — so the gate
  # is the sole browser auth). A LIST, not an attrset: the order fixes
  # gluetun's ports block below, and reordering would change
  # podman-gluetun's ExecStart → gluetun recreate → every netns tenant
  # needs a manual restart.
  vpnUis = [
    {
      name = "qbittorrent";
      port = 8090;
      authBypassRule = "PathPrefix(`/api`)";
      healthPath = "/api/v2/app/version";
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
      healthPath = "/jsonrpc";
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
          # No creds: nzbget auth is disabled (ControlPassword empty —
          # AUTH.md); the API is open, LAN-closed + behind the Pocket
          # ID gate.
        };
      };
    }
    {
      name = "prowlarr";
      port = 9696;
      authBypassRule = arrApiBypass;
      healthPath = "/ping";
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
      authBypassRule = arrApiBypass;
      healthPath = "/ping";
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
      authBypassRule = arrApiBypass;
      healthPath = "/ping";
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
      authBypassRule = arrApiBypass;
      healthPath = "/api/system/status";
      # Authenticated probe: without the key bazarr answers 401, which
      # still passes [STATUS] < 500 — certifying traefik, not bazarr.
      # The value expands from gatus's env.sops at config load.
      healthHeaders."X-API-KEY" = "\${BAZARR_API_KEY}";
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
  config = lib.mkMerge [
    # The VPN netns kit — sops wg key + expiry reminder, kernel modules,
    # gluetun + exporter containers, scrape, homepage tile — comes from
    # platform/gluetun-lib.nix. Everything instance-specific is right here.
    (mkGluetunInstance {
      name = "gluetun";
      secretName = "tv-wg0";
      wgConfSops = ./wg0.conf.sops;
      authConfig = ./assets/config.toml;
      stateRoot = "/home/santiago/selfhost/tv";
      keyExpiry = "2027-04-03";
      reminderDates = [
        "2027-03-04" # 30 days out
        "2027-03-27" # 7 days out
      ];
      reminderPrefix = "tv";
      subject = "TV VPN (gluetun)";
      webUis = vpnUis;
      runbookPath = "/etc/nixos/stacks/tv/tv.nix";

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

      environment = {
        # Direct (non-VPN) egress to the host ONLY — the *arrs dial the
        # shared app-db cluster at host.containers.internal:5433. Under
        # pasta the host is 169.254.1.2 (the LAN IP 192.168.0.2 refers
        # back to the container itself); a /32 so the VPN netns can't
        # reach anything else.
        FIREWALL_OUTBOUND_SUBNETS = "169.254.1.2/32";
        VPN_PORT_FORWARDING = "on";
        VPN_PORT_FORWARDING_PROVIDER = "protonvpn";
        # When ProtonVPN hands out a new forwarded port, push it to
        # qBittorrent so qBT listens there. Requires "Bypass auth for
        # localhost clients" in qBT. {{PORTS}} is gluetun's template.
        VPN_PORT_FORWARDING_UP_COMMAND = "/bin/sh -c 'wget -O- --retry-connrefused --post-data \"json={\\\"listen_port\\\":{{PORTS}}}\" http://127.0.0.1:8090/api/v2/app/setPreferences 2>&1'";
      };

      scrapeTarget = "host.containers.internal:8001";

      homepage = {
        name = "Gluetun";
        # The VPN has no UI of its own — link the grafana network
        # dashboard, where the gluetun/VPN panels live.
        href = "https://grafana.toscanini.me/d/s2-network";
        description = "ProtonVPN WireGuard tunnel (host netns for tv stack)";
        icon = "gluetun.png";
        siteMonitor = "http://host.containers.internal:8000/v1/publicip/ip";
        widget = {
          type = "gluetun";
          url = "http://host.containers.internal:8000";
          version = 2;
        };
      };
    })
    {
      # gluetun owns the netns; tenants have no bridge (`[ ]`, which here
      # just earns the Type=oneshot systemd override). Jellyfin is
      # bridge-routed (outside the VPN).
      # *arr databases on the shared app-db cluster: one role per app,
      # main + log database each (the *arrs keep logs in a separate db).
      # The apps dial host.containers.internal:5433 (= 169.254.1.2, the
      # pasta host address; plain-TCP host port on pg) since the gluetun
      # netns can't join app-db-net; connection settings live in each
      # app's config.xml (mutable state, not in the rebuild trail).
      fleet.appDatabases = {
        sonarr = {
          extraDatabases = [ "sonarr_log" ];
          consumers = [ "sonarr" ];
        };
        radarr = {
          extraDatabases = [ "radarr_log" ];
          consumers = [ "radarr" ];
        };
        prowlarr = {
          extraDatabases = [ "prowlarr_log" ];
          consumers = [ "prowlarr" ];
        };
        bazarr.consumers = [ "bazarr" ];
      };

      # gluetun + gluetun-exporter's entries come from mkGluetunInstance;
      # the remaining tenants are declared here.
      fleet.bridgeMemberships =
        lib.listToAttrs (
          map (n: lib.nameValuePair n [ ]) (lib.subtractLists [ "gluetun-exporter" ] netnsTenants)
        )
        // {
          jellyfin = [ "traefik" ];
        };

      # Loki stack label (stacks/logging logStacks): group the whole
      # netns family + jellyfin under one queryable stack.
      fleet.logStacks.tv = [
        "gluetun"
        "jellyfin"
      ]
      ++ netnsTenants;

      # The gluetun-netns webApps come from mkGluetunInstance (webUis).
      # Jellyfin is bridge-routed — outside the VPN.
      fleet.webApps =
        {
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

      fleet.statePaths = {
        "/home/santiago/selfhost/tv/bazarr" = { };
        "/home/santiago/selfhost/tv/jellyfin" = { };
        "/home/santiago/selfhost/tv/nzbget" = { };
        # nzbget's LogFile points at /config/logs and never creates the dir;
        # missing dir = hundreds of stderr complaints per day.
        "/home/santiago/selfhost/tv/nzbget/logs" = { };
        "/home/santiago/selfhost/tv/prowlarr" = { };
        "/home/santiago/selfhost/tv/qbittorrent" = { };
        "/home/santiago/selfhost/tv/radarr" = { };
        "/home/santiago/selfhost/tv/sonarr" = { };
        "/home/santiago/selfhost/tv/subgen" = { };
        # Content dirs on s2-pool that containers bind directly — declared
        # so a fresh restore pre-creates them with santiago ownership.
        "/s2/tv/media" = { };
        "/s2/tv/torrents" = { };
        "/s2/tv/usenet" = { };
      };

      virtualisation.oci-containers.containers.qbittorrent = mkNetnsTenant {
        image = "docker.io/linuxserver/qbittorrent:5.2.3_v2.0.13-ls468@sha256:352371a7242e8b4aa10958ca02076d1023758070519b89a10251475fb9f1a35a";

        # No /downloads bind: everything lives under /data/torrents (the
        # atomic-move/hardlink layout radarr+sonarr import from). If
        # "keep incomplete in temp path" is ever enabled in the UI, the
        # temp path must also live under /data/torrents — a second bind
        # would force cross-mount copy+delete instead of rename().
        volumes = [
          "/home/santiago/selfhost/tv/qbittorrent:/config"
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

        # Database on the shared app-db cluster (bazarr reads POSTGRES_*
        # env natively; POSTGRES_PASSWORD rides the bootstrap env file).
        environment = {
          POSTGRES_ENABLED = "true";
          POSTGRES_HOST = "host.containers.internal";
          POSTGRES_PORT = "5433";
          POSTGRES_DATABASE = "bazarr";
          POSTGRES_USERNAME = "bazarr";
        };
        environmentFiles = [ config.fleet.appDatabases.bazarr.envFile ];
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

      # Jellyfin runs outside gluetun: LAN streaming must not ride the VPN
      # exit (slow, paid bandwidth). renderD128 = Intel Alder Lake iGPU
      # render node; mode 0666 on host so no `--group-add=render` needed
      # for rootless. i915 is force-loaded in platform/gpu.nix.
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
        ];
      };
    }
  ];
}
