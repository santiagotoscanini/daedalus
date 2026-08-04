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
  fleet.bridgeMemberships.seerr = [
    "traefik"
    "app-db"
  ];

  # Database on the shared app-db cluster (see stacks/app-db/); the
  # container joins app-db-net and dials `pg` by container DNS.
  fleet.appDatabases.seerr.consumers = [ "seerr" ];

  # The image's node user (uid 1000) maps to host 100999; the config
  # dir must exist with that ownership or a fresh install fails on
  # first write.
  fleet.statePaths."/home/santiago/selfhost/seerr/config".uid = 1000;

  fleet.webApps.seerr = {
    serviceName = "seerr";
    port = 5055;
  };

  virtualisation.oci-containers.containers.seerr = mkRootlessContainer {
    image = "ghcr.io/seerr-team/seerr:v3.4.1@sha256:f4768de5f616248d723e05891f3345a1402123775d03bf0890dbfedc0831bda1";

    volumes = [
      "/home/santiago/selfhost/seerr/config:/app/config"
    ];

    environment = {
      DB_TYPE = "postgres";
      DB_HOST = "pg";
      DB_PORT = "5432";
      DB_USER = "seerr";
      DB_NAME = "seerr";
      # Default is debug — which logs "Starting scheduled job: <name>"
      # every 60s (the Download Sync job among them). info drops that
      # per-minute chatter. It does NOT quiet the unhandled-rejection
      # dumps from the intermittently-stalling *arr calls (those are
      # Node's native stderr, below any app log level) — a Loki drop
      # stage in stacks/logging handles those.
      LOG_LEVEL = "info";
    };

    # DB_PASS from the app-db bootstrap env file.
    environmentFiles = [ config.fleet.appDatabases.seerr.envFile ];

  };
}
