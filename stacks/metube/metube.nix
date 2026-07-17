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
  myStack.containerNetworks.metube = "traefik";
  myStack.webApps.metube = {
    serviceName = "metube";
    port = 8081;
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
    image = "ghcr.io/alexta69/metube:2026.07.12@sha256:eca2c82993604c2c4a0d7db7f39a685870c9893775836c7cd4e78cd2d2c8fc4c";

    volumes = [
      "/s2/tv/media/videos:/downloads"
    ];

    environment = {
      UID = "0";
      GID = "0";
    };

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
