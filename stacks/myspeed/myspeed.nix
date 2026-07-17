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
# If a password is set later in the UI, add `password` to the homepage
# widget below.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.myspeed = "traefik";

  myStack.webApps.myspeed = {
    serviceName = "myspeed";
    port = 5216; # in-container port
    # MySpeed's optional password stays unset — its "auth" sends the
    # plaintext password as a header on every request; the Pocket ID
    # gate is the real boundary. Widget dials container-direct.
      auth = "oidc";
    homepage = {
      group = "Network";
      name = "MySpeed";
      description = "Internet speed tracker (scheduled speedtests)";
      icon = "myspeed.png";
      widget = {
        # Native homepage integration — surfaces the latest test's ping,
        # download and upload straight from MySpeed's API.
        type = "myspeed";
        url = "http://myspeed:5216";
        # password = "{{HOMEPAGE_VAR_MYSPEED_PASSWORD}}"; # only if UI auth set
      };
    };
  };

  virtualisation.oci-containers.containers.myspeed = mkRootlessContainer {
    image = "docker.io/germannewsmaker/myspeed:1.0.9@sha256:3a3e774b3f78d930a5a962d625b99bcb3d71730bfeb4a6b93e04fd38cfe7d9a9";

    volumes = [
      "/home/santiago/selfhost/myspeed/data:/myspeed/data"
    ];

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
