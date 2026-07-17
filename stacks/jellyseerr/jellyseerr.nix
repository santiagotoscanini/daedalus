# seerr — request & discovery front-end for the Jellyfin + *arr stack
# (the continuation of jellyseerr under the seerr-team org). The container,
# bridge alias, and hostname stay `jellyseerr` for continuity — only the
# image is the renamed project. Single container on traefik-net; traefik
# dials http://jellyseerr:5055. LAN-only: household requests + operator.
#
# Runs as the image's `node` user (uid 1000 -> host 100999 under rootless
# podman), which must own /app/config on disk (100999:100999).
#
# Upstreams are configured in the web UI, not here:
#   - Jellyfin  http://jellyfin:8096                     (traefik-net, tv.nix)
#   - Radarr    http://host.containers.internal:7878     (gluetun host port)
#   - Sonarr    http://host.containers.internal:8989     (gluetun host port)
# The bridge can reach host.containers.internal, so gluetun's published
# *arr ports are dialable without joining the VPN netns.

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
      name = "Seerr";
      href = "https://jellyseerr.toscanini.me";
      description = "Media requests & discovery";
      icon = "seerr.png";
      siteMonitor = "http://jellyseerr:5055";
      widget = {
        type = "seerr";
        url = "http://jellyseerr:5055";
        key = "{{HOMEPAGE_VAR_JELLYSEERR_API_KEY}}";
      };
    }
  ];

  virtualisation.oci-containers.containers.jellyseerr = mkRootlessContainer {
    image = "ghcr.io/seerr-team/seerr:v3.3.0@sha256:2892b14e960d946fb91573792505dcba011075638f27104360fd21aa157fa2bc";

    volumes = [
      "/home/santiago/selfhost/jellyseerr/config:/app/config"
    ];

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
