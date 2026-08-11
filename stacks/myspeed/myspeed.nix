# myspeed — self-hosted internet speed tracker (gnmyt/myspeed).
#
# Runs scheduled speedtests from the server itself and keeps a history
# of ping / download / upload, with a web UI to browse trends and set
# the test cadence. Single container, no secrets, no inter-container
# DNS, no VPN — joins traefik-net so traefik dials `http://myspeed:5216`
# directly, no host port published.
#
# The image sets no USER, so it runs as container root (UID 0) which
# maps to host santiago (1000:100) in our rootless setup — that owns
# the bind-mounted data dir cleanly. SQLite history lives at
# /myspeed/data (the image's declared volume), bind-mounted to keep it
# inside the /home/santiago/selfhost backup tree rather than a named
# volume.
#
# No auth is configured (single-user LAN + CF-tunnel-off by default).
# If a password is set later in the UI, daedalus reads the numbers from
# prometheus rather than the API, so nothing needs the credential.

{ config, mkRootlessContainer, ... }:

{
  fleet.bridgeMemberships.myspeed = [ "traefik" ];

  fleet.statePaths."${config.fleet.stateRoot}/myspeed/data" = { };

  # Prometheus scrapes MySpeed's native endpoint (prom-client at
  # /api/prometheus/metrics, no auth since passwordLevel=none) directly
  # over traefik-net — going through traefik would hit the oidc gate.
  # Emits myspeed_{ping,download,upload,server,time} for the latest
  # hourly test; graphed on the Network dashboard's "Internet Speed" row.
  fleet.prometheusScrapes = [
    {
      job_name = "myspeed";
      metrics_path = "/api/prometheus/metrics";
      scrape_interval = "60s";
      static_configs = [ { targets = [ "myspeed:5216" ]; } ];
    }
  ];

  fleet.webApps.myspeed = {
    serviceName = "myspeed";
    port = 5216; # in-container port
    # MySpeed's optional password stays unset — its "auth" sends the
    # plaintext password as a header on every request; the Pocket ID
    # gate is the real boundary. Widget dials container-direct.
    auth = "oidc";
    # Household app: santi + sofi, not admins-only.
    authGroups = [
      "admins"
      "family"
    ];
    healthPath = "/favicon.ico";
  };
  # Consent screen and Pocket ID's My Apps page.
  fleet.ssoClients.myspeed = {
    displayName = "MySpeed";
    description = "Internet speed tracker";
  };

  virtualisation.oci-containers.containers.myspeed = mkRootlessContainer {
    image = "docker.io/germannewsmaker/myspeed:1.0.9@sha256:3a3e774b3f78d930a5a962d625b99bcb3d71730bfeb4a6b93e04fd38cfe7d9a9";

    volumes = [
      "${config.fleet.stateRoot}/myspeed/data:/myspeed/data"
    ];

  };
}
