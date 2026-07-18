# metube — youtube-dl web UI, sibling of the tv stack.
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
  myStack.containerNetworks.metube = [ "traefik" ];
  myStack.webApps.metube = {
    serviceName = "metube";
    port = 8081;
    # No auth of its own (upstream: none planned). Homepage widget
    # dials http://metube:8081 container-direct, unaffected.
      auth = "oidc";
      healthPath = "/favicon.ico";
    homepage = {
      group = "Media";
      name = "MeTube";
      description = "YouTube-dl web UI (writes to /s2/tv/media/videos)";
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
    image = "ghcr.io/alexta69/metube:2026.07.18@sha256:98e1c8f37b009954ed1a663908f9c7fb102153d98bc06b5d51926381d1a3641c";

    volumes = [
      "/s2/tv/media/videos:/downloads"
    ];

    environment = {
      UID = "0";
      GID = "0";
    };

    extraOptions = [
    ];
  };
}
