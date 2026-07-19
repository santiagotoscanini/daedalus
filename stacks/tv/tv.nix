# tv stack — media acquisition + library (TV/movies content).
#
# The shared VPN egress + Cloudflare solver live in stacks/downloads:
# gluetun owns the netns and publishes every tenant's port. This stack
# only declares TV *content* — the downloaders (qbittorrent, nzbget), the
# indexer (prowlarr), the *arrs (radarr, sonarr, bazarr) and subgen — as
# netns tenants (`--net=container:gluetun`, so their egress rides the VPN)
# and contributes their ports/UIs to `fleet.gluetunTenants.gluetun`, which
# the downloads stack turns into published ports + Pocket-ID webApps.
#
# Jellyfin is OUTSIDE the VPN (joins traefik-net) so LAN streaming doesn't
# loop through ProtonVPN exit nodes.

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
    mkNetnsTenant
    ;

  # Shared auth-bypass rule for the *arrs (Servarr apps expose the same
  # API surface): API-key callers, /api, RSS /feed, and /ping skip the
  # Pocket ID gate.
  arrApiBypass = "HeaderRegexp(`X-Api-Key`, `.+`) || PathPrefix(`/api`) || PathPrefix(`/feed`) || PathPrefix(`/ping`)";

  # tv's netns tenants (bodies below) — each gets the `[ ]` bridge
  # membership (Type=oneshot override) and a Loki stack label.
  tvNetnsTenants = [
    "qbittorrent"
    "nzbget"
    "prowlarr"
    "radarr"
    "sonarr"
    "bazarr"
    "subgen"
  ];
in
{
  # Publish tv's tenants on the shared gluetun (stacks/downloads owns the
  # netns + assembles the sorted port union). AUTH.md: every app's own
  # login is disabled (arrs: AuthenticationMethod=External; qbt: subnet
  # whitelist; nzbget: no password; bazarr: auth type null), so the Pocket
  # ID gate is the sole browser auth; the bypass rule lets machine callers
  # (API keys, RPC paths) through since they can't do an OIDC redirect.
  fleet.gluetunTenants.gluetun = [
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
    {
      # subgen — dual API on :9000: /asr (Bazarr dials 127.0.0.1:9000
      # in-netns) and /v1/audio/... (OpenAI shape — litellm reaches it at
      # host.containers.internal:9000). Publish-only, no browser UI.
      port = 9000;
      ui = false;
    }
  ];

  # *arr databases on the shared app-db cluster: one role per app, main +
  # log database each (the *arrs keep logs in a separate db). The apps
  # dial host.containers.internal:5433 (= 169.254.1.2, the pasta host
  # address; plain-TCP host port on pg) since the gluetun netns can't join
  # app-db-net; connection settings live in each app's config.xml (mutable
  # state, not in the rebuild trail).
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

  # Netns tenants have no bridge (`[ ]`, which still earns the Type=oneshot
  # systemd override). Jellyfin is bridge-routed (outside the VPN).
  fleet.bridgeMemberships =
    lib.listToAttrs (map (n: lib.nameValuePair n [ ]) tvNetnsTenants)
    // {
      jellyfin = [ "traefik" ];
    };

  # Loki stack label (stacks/logging logStacks): group the tv content
  # tenants + jellyfin. gluetun/flaresolverr live under logStacks.downloads.
  fleet.logStacks.tv = [ "jellyfin" ] ++ tvNetnsTenants;

  # Jellyfin is bridge-routed — outside the VPN.
  fleet.webApps.jellyfin = {
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

  virtualisation.oci-containers.containers.qbittorrent = mkNetnsTenant "gluetun" {
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

  virtualisation.oci-containers.containers.nzbget = mkNetnsTenant "gluetun" {
    image = "docker.io/linuxserver/nzbget:v26.2-ls254@sha256:87eba87ec46982b003ab1f54cfabd962c5c5e95cb9eb2069cbec7b6370d0784b";

    volumes = [
      "/home/santiago/selfhost/tv/nzbget:/config"
      "/s2/tv/usenet:/data/usenet:rw"
    ];
  };

  virtualisation.oci-containers.containers.prowlarr = mkNetnsTenant "gluetun" {
    image = "docker.io/linuxserver/prowlarr:2.4.0.5397-ls154@sha256:4fd7a166c8f46dd3370a871c250ee577d6c2ae97a0dbe0e3614b5ef736205620";

    volumes = [
      "/home/santiago/selfhost/tv/prowlarr:/config"
    ];
  };

  # /s2/tv (not /s2/tv/media) because radarr's "import from download
  # client" hardlinks across /downloads, /torrents, /media — all need
  # to be on the same filesystem under one bind mount.
  virtualisation.oci-containers.containers.radarr = mkNetnsTenant "gluetun" {
    image = "docker.io/linuxserver/radarr:6.3.0.10514-ls311@sha256:2b2c1c05eb3f648d2c80dfab9486147dd7bb0ad4d77fa972fc1c5de8f1da3738";

    volumes = [
      "/home/santiago/selfhost/tv/radarr:/config"
      "/s2/tv:/data"
    ];
  };

  virtualisation.oci-containers.containers.sonarr = mkNetnsTenant "gluetun" {
    image = "docker.io/linuxserver/sonarr:4.0.19.2979-ls320@sha256:24acea2956a0ccb11f103877d9f4f8576600fb34bff34820ed749c2256dab89f";

    volumes = [
      "/home/santiago/selfhost/tv/sonarr:/config"
      "/s2/tv:/data"
    ];
  };

  # bazarr only reads what the *arrs produce, so a narrower bind.
  virtualisation.oci-containers.containers.bazarr = mkNetnsTenant "gluetun" {
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
  virtualisation.oci-containers.containers.subgen = mkNetnsTenant "gluetun" {
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
