# jellyseerr (Seerr) — request & discovery front-end for the Jellyfin +
# *arr stack. Single container on traefik-net; traefik dials
# http://jellyseerr:5055. LAN-only: household requests + operator-facing.
#
# Runs as container root, so /app/config on disk is santiago:users
# (1000:100).
#
# Upstreams are configured in the web UI, not here:
#   - Jellyfin  http://jellyfin:8096                     (traefik-net, tv.nix)
#   - Radarr    http://host.containers.internal:7878     (gluetun host port)
#   - Sonarr    http://host.containers.internal:8989     (gluetun host port)
# The bridge can reach host.containers.internal, so gluetun's published
# *arr ports are dialable without joining the VPN netns.
#
# Project is being renamed upstream (fallenbagel/jellyseerr -> seerr-team/
# seerr); revisit the image source at the next version bump.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.jellyseerr = "traefik";

  myStack.webApps.jellyseerr = {
    hostname = "jellyseerr.toscanini.me";
    serviceName = "jellyseerr";
    port = 5055;
  };

  myStack.homepageServices."Media" = [
    {
      name = "Jellyseerr";
      href = "https://jellyseerr.toscanini.me";
      description = "Media requests & discovery";
      icon = "jellyseerr.png";
      siteMonitor = "http://jellyseerr:5055";
    }
  ];

  virtualisation.oci-containers.containers.jellyseerr = mkRootlessContainer {
    image = "docker.io/fallenbagel/jellyseerr:2.7.3@sha256:4538137bc5af902dece165f2bf73776d9cf4eafb6dd714670724af8f3eb77764";

    volumes = [
      "/home/santiago/selfhost/jellyseerr/config:/app/config"
    ];

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
