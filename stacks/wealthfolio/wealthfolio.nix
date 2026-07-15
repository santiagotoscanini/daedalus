# wealthfolio — personal finance tracker. Single container, split-
# horizon publish. Joins traefik-net so traefik dials
# `http://wealthfolio:8088` — no host port published.
#
# To rotate the admin password, regenerate the argon2 hash:
#   echo -n "<new-pass>" | argon2 "<salt>" -id -m 12 -t 3 -p 1 -e
# The output is WF_AUTH_PASSWORD_HASH (single `$`, no escaping — unlike
# the old compose, which doubled `$` for its own interpolation). Then
# `systemctl restart podman-wealthfolio`.

{ config, mkRootlessContainer, ... }:

{
  myStack.containerNetworks.wealthfolio = "traefik";
  myStack.webApps.wealthfolio = {
    hostname = "wealthfolio.toscanini.me";
    serviceName = "wealthfolio";
    port = 8088;
    exposeRemotely = true;
  };


  myStack.homepageServices."Productivity" = [{
    name = "Wealthfolio";
    href = "https://wealthfolio.toscanini.me";
    description = "Personal finance";
    icon = "/icons/wealthfolio.png";
    siteMonitor = "http://wealthfolio:8088";
  }];

  # WF_* secrets: sops-encrypted env.sops -> /run/secrets/wealthfolio-env
  # (tmpfs, 0400 santiago). Edit with `sops env.sops`.
  sops.secrets."wealthfolio-env" = {
    sopsFile = ./env.sops;
    format   = "dotenv";
    key      = "";
    owner    = "santiago";
  };

  virtualisation.oci-containers.containers.wealthfolio = mkRootlessContainer {
    image = "docker.io/afadil/wealthfolio:latest";

    volumes = [
      "/home/santiago/selfhost/wealthfolio/data:/data"
    ];

    # WF_LISTEN_ADDR + WF_DB_PATH + WF_SECRET_KEY + WF_AUTH_PASSWORD_HASH
    # + WF_CORS_ALLOW_ORIGINS.
    environmentFiles = [ config.sops.secrets."wealthfolio-env".path ];

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
