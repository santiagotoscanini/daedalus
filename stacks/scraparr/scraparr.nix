# scraparr — one Prometheus exporter for the whole media pipeline
# (thecfu/scraparr, same org as gluetun-exporter): Sonarr, Radarr,
# Prowlarr, Bazarr, Jellyfin and Seerr metrics from a single container.
# Chosen over exportarr: one instance instead of four, covers Jellyfin +
# Seerr (exportarr does neither), dotenv config, official dashboard.
#
# Seerr is a jellyseerr fork — scraparr's JELLYSEERR_* connector speaks
# its API (verified; SEERR_* vars don't exist in 3.0.3).
#
# Networks: monitoring-net primary (prometheus scrapes scraparr:7100 by
# DNS) + traefik-net secondary (jellyfin/seerr by container DNS); the
# *arrs are dialed via gluetun's host-published ports. Stateless — no
# volumes.
#
# assets/media-pipeline.json is the official scraparr dashboard
# (grafana.com/22934) with its datasource var pinned to the provisioned
# prometheus uid.

{ config, mkRootlessContainer, ... }:

{
  myStack.containerNetworks.scraparr = "monitoring";

  # SONARR/RADARR/PROWLARR/BAZARR/JELLYSEERR/JELLYFIN_API_KEY.
  # Jellyfin uses a dedicated "Scraparr" API key (minted via /Auth/Keys).
  # Edit with `sops env.sops`.
  sops.secrets."scraparr-env" = {
    sopsFile = ./env.sops;
    format = "dotenv";
    key = "";
    owner = "santiago";
  };

  myStack.prometheusScrapes = [
    {
      job_name = "scraparr";
      static_configs = [ { targets = [ "scraparr:7100" ]; } ];
    }
  ];

  myStack.grafanaDashboardsByFolder."Media".media-pipeline = builtins.readFile ./assets/media-pipeline.json;

  virtualisation.oci-containers.containers.scraparr = mkRootlessContainer {
    image = "ghcr.io/thecfu/scraparr:3.0.3@sha256:44f09d30009508a2a422ae7cd9cce38fa36122d6bd0592f2e4158398d9ccb7a6";

    environment = {
      SONARR_URL = "http://host.containers.internal:8989";
      RADARR_URL = "http://host.containers.internal:7878";
      PROWLARR_URL = "http://host.containers.internal:9696";
      BAZARR_URL = "http://host.containers.internal:6767";
      JELLYSEERR_URL = "http://seerr:5055";
      JELLYFIN_URL = "http://jellyfin:8096";
    };

    environmentFiles = [ config.sops.secrets."scraparr-env".path ];

    extraOptions = [
      "--network=monitoring-net"
      "--network=traefik-net"
    ];
  };
}
