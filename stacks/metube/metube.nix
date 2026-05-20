# metube — youtube-dl web UI, sibling of the tv stack.
#
# Standalone (no VPN), pasta networking. Writes downloads to
# /s2/tv/media/videos which is already part of the jellyfin library —
# anything pulled here surfaces in Jellyfin's Videos folder.
#
# UID/GID env vars on this image are `UID`/`GID` (not the linuxserver
# `PUID`/`PGID`). Same rationale as the tv stack: container UID 0 maps
# to host santiago in our rootless setup, so UID=0 GID=0 = run as the
# user that owns the videos dir.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.metube = null;
  myStack.traefikRoutes.metube = {
    host = "metube.s2.toscanini.me";
    port = 8081;
  };


  myStack.dnsHosts = [ "192.168.0.2 metube.s2.toscanini.me" ];

  myStack.homepageServices."Media" = [{
    name = "MeTube";
    href = "https://metube.s2.toscanini.me";
    description = "YouTube-dl web UI (writes to /s2/tv/media/videos)";
    icon = "metube.png";
    siteMonitor = "http://host.containers.internal:8081";
  }];

  virtualisation.oci-containers.containers.metube = mkRootlessContainer {
    image = "ghcr.io/alexta69/metube:2026.04.04";

    ports = [ "8081:8081" ];

    volumes = [
      "/s2/tv/media/videos:/downloads"
    ];

    environment = {
      UID = "0";
      GID = "0";
    };
  };
}
