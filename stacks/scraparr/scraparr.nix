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
# (grafana.com/22934); it keeps a free datasource template variable and
# resolves via the provisioned prometheus datasource being isDefault.

{
  config,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

{
  fleet.bridgeMemberships.scraparr = [
    "monitoring"
    "traefik"
  ];

  # SONARR/RADARR/PROWLARR/BAZARR/JELLYSEERR/JELLYFIN_API_KEY.
  # Jellyfin uses a dedicated "Scraparr" API key (minted via /Auth/Keys).
  # Edit with `sops env.sops`.
  sops.secrets."scraparr-env" = mkDotenvSecret ./env.sops;

  fleet.prometheusScrapes = [
    {
      job_name = "scraparr";
      static_configs = [ { targets = [ "scraparr:7100" ]; } ];
    }
  ];

  fleet.grafanaDashboardsByFolder."Media".media-pipeline =
    builtins.readFile ./assets/media-pipeline.json;

  # GENERAL_LOG_LEVEL=WARNING silences the connector INFO chatter. The
  # per-scrape access line ("GET /metrics ... 200") still lands at
  # journald err priority: wsgiref's request handler writes it to
  # stderr directly, bypassing Python logging — no level can silence
  # it without an upstream patch.
  virtualisation.oci-containers.containers.scraparr = mkRootlessContainer {
    image = "ghcr.io/thecfu/scraparr:3.0.3@sha256:44f09d30009508a2a422ae7cd9cce38fa36122d6bd0592f2e4158398d9ccb7a6";

    environment = {
      GENERAL_LOG_LEVEL = "WARNING";
      SONARR_URL = "http://host.containers.internal:8989";
      RADARR_URL = "http://host.containers.internal:7878";
      PROWLARR_URL = "http://host.containers.internal:9696";
      BAZARR_URL = "http://host.containers.internal:6767";
      JELLYSEERR_URL = "http://seerr:5055";
      JELLYFIN_URL = "http://jellyfin:8096";

      # Four services polled every two minutes instead of scraparr's 30s
      # default, and the reason is the transport rather than the data.
      #
      # These four are dialed at a port published out of the ROOTLESS network
      # namespace (gluetun owns the netns; only it can publish). Opening a new
      # connection to one of those occasionally hangs on the SYN and recovers
      # only after the kernel's retransmit ladder, ~10.5s — see the long note
      # on `getJson` in stacks/daedalus/app/src/lib/dashboard/clients.ts, which
      # rides it out with a retry ladder. scraparr cannot: every request it
      # makes carries a hardcoded `timeout=10` with no retry and no setting to
      # change either, so each stall lands just inside the timeout and becomes
      # a failed scrape — 4,951 error lines in seven days, and a
      # `scraparr_services_up` that dips to 0 on the Media dashboard while the
      # service is perfectly healthy.
      #
      # Nothing here fixes that; the fix is a timeout above ~10.5s, which needs
      # an upstream change or a patched image. What an interval DOES control is
      # how many new connections get opened at all, so four times fewer polls is
      # four times fewer stalls. The cost is resolution these numbers do not
      # need: a library count and a queue depth at two-minute grain are the same
      # answer, and the dashboards reading them are five-minute grain anyway.
      #
      # Jellyfin and Seerr keep the default — they are reached by container DNS
      # over a bridge, which does not have this failure mode at all (1 and 0
      # errors over the same week, against ~1,200 each for the four above).
      SONARR_INTERVAL = "120";
      RADARR_INTERVAL = "120";
      PROWLARR_INTERVAL = "120";
      BAZARR_INTERVAL = "120";
    };

    environmentFiles = [ config.sops.secrets."scraparr-env".path ];

  };
}
