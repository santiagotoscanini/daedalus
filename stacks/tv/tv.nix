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
    }
    {
      name = "nzbget";
      port = 6789;
      authBypassRule = "PathPrefix(`/jsonrpc`)";
      healthPath = "/jsonrpc";
    }
    {
      name = "prowlarr";
      port = 9696;
      authBypassRule = arrApiBypass;
      healthPath = "/ping";
    }
    {
      name = "radarr";
      port = 7878;
      authBypassRule = arrApiBypass;
      healthPath = "/ping";
    }
    {
      name = "sonarr";
      port = 8989;
      authBypassRule = arrApiBypass;
      healthPath = "/ping";
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
    }
    {
      # subgen — dual API on :9000: /asr (Bazarr dials 127.0.0.1:9000
      # in-netns) and /v1/audio/... (OpenAI shape — litellm reaches it at
      # host.containers.internal:9000). Publish-only, no browser UI.
      port = 9000;
      ui = false;
    }
  ];

  # Consent screen and Pocket ID's My Apps page, per gated UI.
  fleet.ssoClients = {
    qbittorrent = {
      displayName = "qBittorrent";
      description = "BitTorrent (via gluetun/ProtonVPN)";
    };
    nzbget = {
      displayName = "NZBGet";
      description = "Usenet downloader (via gluetun)";
    };
    prowlarr.description = "Indexer aggregator";
    radarr.description = "Movies";
    sonarr.description = "TV shows";
    bazarr.description = "Subtitles";
  };

  # *arr databases on the shared app-db cluster: one role per app, main +
  # log database each (the *arrs keep logs in a separate db).
  #
  # `reach = "hostPort"` because these share gluetun's netns, which has no
  # bridge interface, so the container DNS name `pg` does not resolve there —
  # they dial the plain-TCP host port instead. Saying it here is what makes
  # the generated DATABASE_URL true for them; left at the "bridge" default it
  # named a host they cannot reach, which was harmless only because the *arrs
  # read config.xml (mutable state, not in the rebuild trail) rather than the
  # env file, and misleading to anyone who looked.
  fleet.appDatabases = {
    sonarr = {
      extraDatabases = [ "sonarr_log" ];
      consumers = [ "sonarr" ];
      reach = "hostPort";
    };
    radarr = {
      extraDatabases = [ "radarr_log" ];
      consumers = [ "radarr" ];
      reach = "hostPort";
    };
    prowlarr = {
      extraDatabases = [ "prowlarr_log" ];
      consumers = [ "prowlarr" ];
      reach = "hostPort";
    };
    bazarr = {
      consumers = [ "bazarr" ];
      reach = "hostPort";
    };
  };

  # Netns tenants have no bridge (`[ ]`, which still earns the Type=oneshot
  # systemd override). Jellyfin is bridge-routed (outside the VPN).
  fleet.bridgeMemberships = lib.listToAttrs (map (n: lib.nameValuePair n [ ]) tvNetnsTenants) // {
    jellyfin = [ "traefik" ];
  };

  # Loki stack label (stacks/logging logStacks): group the tv content
  # tenants + jellyfin. gluetun/flaresolverr live under logStacks.downloads.
  fleet.logStacks.tv = [ "jellyfin" ] ++ tvNetnsTenants;

  # Jellyfin is bridge-routed — outside the VPN.
  fleet.webApps.jellyfin = {
    serviceName = "jellyfin";
    port = 8096;
  };

  fleet.statePaths = {
    "${config.fleet.stateRoot}/tv/bazarr" = { };
    "${config.fleet.stateRoot}/tv/jellyfin" = { };
    "${config.fleet.stateRoot}/tv/nzbget" = { };
    # nzbget's LogFile points at /config/logs and never creates the dir;
    # missing dir = hundreds of stderr complaints per day.
    "${config.fleet.stateRoot}/tv/nzbget/logs" = { };
    "${config.fleet.stateRoot}/tv/prowlarr" = { };
    "${config.fleet.stateRoot}/tv/qbittorrent" = { };
    "${config.fleet.stateRoot}/tv/radarr" = { };
    "${config.fleet.stateRoot}/tv/sonarr" = { };
    "${config.fleet.stateRoot}/tv/subgen" = { };
    # Content dirs on s2-pool that containers bind directly — declared
    # so a fresh restore pre-creates them with santiago ownership.
    "/s2/tv/media" = { };
    "/s2/tv/torrents" = { };
    "/s2/tv/usenet" = { };
  };

  virtualisation.oci-containers.containers.qbittorrent = mkNetnsTenant "gluetun" {
    image = "docker.io/linuxserver/qbittorrent:5.2.3_v2.0.14-ls474@sha256:a00b6a597a3832a1814cde0ef60abc55c94644f3f80902c3432f6af6de8d4a96";

    # No /downloads bind: everything lives under /data/torrents (the
    # atomic-move/hardlink layout radarr+sonarr import from). If
    # "keep incomplete in temp path" is ever enabled in the UI, the
    # temp path must also live under /data/torrents — a second bind
    # would force cross-mount copy+delete instead of rename().
    volumes = [
      "${config.fleet.stateRoot}/tv/qbittorrent:/config"
      "/s2/tv/torrents:/data/torrents:rw"
      # Books, and deliberately a SEPARATE mount on a separate dataset. The
      # note above is about keeping the *arrs' hardlink space on one
      # filesystem; a book never takes that path — shelfmark copies it out to
      # the CWA ingest folder — so there is nothing to hardlink and every
      # reason to keep it off the media pool. Shelfmark declares the state
      # path and mounts the same directory read-only at the same container
      # path (stacks/shelfmark).
      "/s2/books/torrents:/data/books:rw"
    ];

    environment.WEBUI_PORT = "8090";
  };

  virtualisation.oci-containers.containers.nzbget = mkNetnsTenant "gluetun" {
    image = "docker.io/linuxserver/nzbget:v26.3-ls261@sha256:5f3d3fa71029004156eff2cbf4ef4455ce4ce59517cf13fa7d1d7c8a4cd2c8a4";

    volumes = [
      "${config.fleet.stateRoot}/tv/nzbget:/config"
      "/s2/tv/usenet:/data/usenet:rw"
    ];
  };

  virtualisation.oci-containers.containers.prowlarr = mkNetnsTenant "gluetun" {
    image = "docker.io/linuxserver/prowlarr:2.5.2.5491-ls158@sha256:91844fa2c927ad6ede5630127183cc7868b175f6223e83e6a5da1fffea2aa782";

    volumes = [
      "${config.fleet.stateRoot}/tv/prowlarr:/config"
    ];
  };

  # /s2/tv (not /s2/tv/media) because radarr's "import from download
  # client" hardlinks across /downloads, /torrents, /media — all need
  # to be on the same filesystem under one bind mount.
  virtualisation.oci-containers.containers.radarr = mkNetnsTenant "gluetun" {
    image = "docker.io/linuxserver/radarr:6.3.0.10514-ls314@sha256:119aaa4a4f7349bcd2a136c5373a0d7925b5479915c7dfe0c0ad352db2a6d438";

    volumes = [
      "${config.fleet.stateRoot}/tv/radarr:/config"
      "/s2/tv:/data"
    ];
  };

  virtualisation.oci-containers.containers.sonarr = mkNetnsTenant "gluetun" {
    image = "docker.io/linuxserver/sonarr:4.0.19.2979-ls322@sha256:c19aa4ecdf03d73e1d5c901da33744cb7eb4d921f89bafed1ca264601d7fa224";

    volumes = [
      "${config.fleet.stateRoot}/tv/sonarr:/config"
      "/s2/tv:/data"
    ];
  };

  # bazarr only reads what the *arrs produce, so a narrower bind.
  virtualisation.oci-containers.containers.bazarr = mkNetnsTenant "gluetun" {
    image = "docker.io/linuxserver/bazarr:v1.6.0-ls362@sha256:a20fb11a440d704a9d61c283aa26462aad33dc63223b173f8d8c77d33e8e9d59";

    volumes = [
      "${config.fleet.stateRoot}/tv/bazarr:/config"
      "/s2/tv/media:/data/media"
    ];

    # Database on the shared app-db cluster. bazarr reads POSTGRES_* natively
    # but wants its own spellings (_USERNAME/_DATABASE, not the _USER/_DB the
    # bootstrap file emits), so those two are named here; the password rides
    # the bootstrap env file. Host and port are READ from the registry rather
    # than restated — they are decided by `reach` above, and a second copy
    # here is a copy that can disagree with the connection string the
    # bootstrap writes.
    environment = {
      POSTGRES_ENABLED = "true";
      POSTGRES_HOST = config.fleet.appDatabases.bazarr.dbHost;
      POSTGRES_PORT = toString config.fleet.appDatabases.bazarr.dbPort;
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
    image = "docker.io/mccloud/subgen:cpu@sha256:d26f285ee7ab1f48d45a6b5aea7c1b1f999b16c3770b71eee10e8602ae374cc5";

    volumes = [
      "${config.fleet.stateRoot}/tv/subgen:/models"
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
    image = "docker.io/linuxserver/jellyfin:10.11.11ubu2604-ls47@sha256:438e44330078e6b1a810fdec9dc0f4773e6595edb137c5eb4417a516da4c7f0e";

    volumes = [
      "${config.fleet.stateRoot}/tv/jellyfin:/config"
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
