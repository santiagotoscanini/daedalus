# metube — yt-dlp web UI, sibling of the tv stack.
#
# Standalone (no VPN), traefik-net for HTTP routing — traefik reaches
# via `http://metube:8081`, no host port published. Writes downloads
# to /s2/tv/media/videos which is already part of the jellyfin
# library — anything pulled here surfaces in Jellyfin's Videos folder.
#
# UID/GID env vars on this image are `UID`/`GID` (not the linuxserver
# `PUID`/`PGID`). Same rationale as the tv stack: container UID 0 maps
# to host santiago in our rootless setup, so UID=0 GID=0 = run as the
# user that owns the videos dir.

{ mkRootlessContainer, ... }:

{
  fleet.bridgeMemberships.metube = [ "traefik" ];
  fleet.webApps.metube = {
    serviceName = "metube";
    port = 8081;
    # No auth of its own (upstream: none planned). Homepage widget
    # dials http://metube:8081 container-direct, unaffected.
    auth = "oidc";
    # Household app: santi + sofi, not admins-only.
    authGroups = [ "admins" "family" ];
    healthPath = "/favicon.ico";
    homepage = {
      group = "Media";
      name = "MeTube";
      description = "yt-dlp web UI (writes to /s2/tv/media/videos)";
      icon = "metube.png";
      widget = {
        type = "customapi";
        # /history → {"done":[...], "queue":[...], "pending":[...]}
        url = "http://metube:8081/history";
        refreshInterval = 30000;
        mappings = [
          {
            field = "queue";
            label = "Queued";
            format = "size";
          }
          {
            field = "pending";
            label = "Pending";
            format = "size";
          }
          {
            field = "done";
            label = "Done";
            format = "size";
          }
        ];
      };
    };
  };

  virtualisation.oci-containers.containers.metube = mkRootlessContainer {
    image = "ghcr.io/alexta69/metube:2026.07.27@sha256:b6e945b63df6357bc16c7bfcb1b4479856b2087f6d8a5e59f0d3f4996a707e12";

    volumes = [
      "/s2/tv/media/videos:/downloads"
    ];

    environment = {
      UID = "0";
      GID = "0";
      # Default INFO logs "Sending download history" to stderr on every
      # poll — journald err-priority noise.
      LOGLEVEL = "WARNING";
    };

  };
}
