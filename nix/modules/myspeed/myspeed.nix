# myspeed — self-hosted internet speed tracker (gnmyt/myspeed).
#
# Runs scheduled speedtests from the server itself and keeps a history
# of ping / download / upload, with a web UI to browse trends and set
# the test cadence. Single container, no secrets, no inter-container
# DNS, no VPN — joins the reverse proxy's bridge so it is dialled at
# `http://myspeed:5216`, no host port published.
#
# The image sets no USER, so it runs as container root (UID 0) which
# maps to the operator in the rootless setup — that owns the bind-mounted
# data dir cleanly. SQLite history lives at /myspeed/data (the image's
# declared volume), bind-mounted to keep it inside the state tree rather
# than a named volume.
#
# No auth is configured: MySpeed's optional password sends the plaintext
# password as a header on every request, so the identity provider's gate
# is the real boundary. Its cadence is DB state, set in the UI — mind the
# hour: a test at :00 saturates the uplink and takes LAN DNS with it.
#
# The host brings:
#   fleet.modules.myspeed.enable      the switch (default off, as every catalog module)
#   fleet.modules.myspeed.authGroups  who may log in (default: admins)
#   fleet.images.myspeed              the digest-pinned image

{
  config,
  lib,
  mkRootlessContainer,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet.modules.myspeed;
in
{
  options.fleet.modules.myspeed = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "MySpeed — self-hosted internet speed tracker.";
    };

    authGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "admins" ];
      description = ''
        Identity-provider groups allowed through the login gate. Policy, so
        the host's: a household that shares the tracker adds its own group.
      '';
      example = [
        "admins"
        "household"
      ];
    };
  };

  config = lib.mkIf cfg.enable {
    fleet.bridgeMemberships.myspeed = [ "traefik" ];

    fleet.statePaths."${config.fleet.stateRoot}/myspeed/data" = { };

    # Prometheus scrapes MySpeed's native endpoint (prom-client at
    # /api/prometheus/metrics, no auth since passwordLevel=none) directly
    # over the shared bridge — going through the proxy would hit the gate.
    # Emits myspeed_{ping,download,upload,server,time} for the latest test;
    # graphed on the Network dashboard's "Internet Speed" row.
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
      auth = "oidc";
      inherit (cfg) authGroups;
      healthPath = "/favicon.ico";
    };
    # Consent screen and the identity provider's My Apps page.
    fleet.ssoClients.myspeed = {
      displayName = "MySpeed";
      description = "Internet speed tracker";
    };

    virtualisation.oci-containers.containers.myspeed = mkRootlessContainer {
      image = pinnedImage "myspeed" "docker.io/germannewsmaker/myspeed";

      volumes = [
        "${config.fleet.stateRoot}/myspeed/data:/myspeed/data"
      ];

    };
  };
}
