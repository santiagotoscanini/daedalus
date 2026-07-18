# seerr — request & discovery front-end for the Jellyfin + *arr stack
# (seerr-team/seerr, the continuation of jellyseerr + overseerr). Single
# container on traefik-net; traefik dials http://seerr:5055. LAN-only:
# household requests + operator-facing.
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

{
  config,
  mkRootlessContainer,
  ...
}:

{
  myStack.containerNetworks.seerr = [
    "traefik"
    "app-db"
  ];

  # Database on the shared app-db cluster (see stacks/app-db/); the
  # container joins app-db-net and dials `pg` by container DNS.
  myStack.appDatabases.seerr.consumers = [ "seerr" ];

  # The image's node user (uid 1000) maps to host 100999; the config
  # dir must exist with that ownership or a fresh install fails on
  # first write.
  myStack.stateDirs."/home/santiago/selfhost/seerr/config".uid = 1000;

  myStack.webApps.seerr = {
    serviceName = "seerr";
    port = 5055;
    homepage = {
      group = "Media";
      description = "Media requests & discovery";
      icon = "seerr.png";
      widget = {
        type = "seerr";
        url = "http://seerr:5055";
        key = "{{HOMEPAGE_VAR_SEERR_API_KEY}}";
      };
    };
  };

  virtualisation.oci-containers.containers.seerr = mkRootlessContainer {
    image = "ghcr.io/seerr-team/seerr:v3.3.0@sha256:2892b14e960d946fb91573792505dcba011075638f27104360fd21aa157fa2bc";

    volumes = [
      "/home/santiago/selfhost/seerr/config:/app/config"
    ];

    environment = {
      DB_TYPE = "postgres";
      DB_HOST = "pg";
      DB_PORT = "5432";
      DB_USER = "seerr";
      DB_NAME = "seerr";
    };

    # DB_PASS from the app-db bootstrap env file.
    environmentFiles = [ config.myStack.appDatabases.seerr.envFile ];

  };
}
