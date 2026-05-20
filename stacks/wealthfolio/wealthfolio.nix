# wealthfolio — personal finance tracker.
#
# Single-container, CF-tunnel only (no LAN host).
#
# To rotate the admin password, regenerate the argon2 hash:
#   echo -n "<new-pass>" | argon2 "<salt>" -id -m 12 -t 3 -p 1 -e
# The output is WF_AUTH_PASSWORD_HASH (single `$`, no escaping — unlike
# the old compose, which doubled `$` for its own interpolation). Then
# `systemctl restart podman-wealthfolio`.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks.wealthfolio = null;
  myStack.traefikRoutes.wealthfolio = {
    host = "wealthfolio.toscanini.me";
    port = 8088;
    entrypoint = "cfweb";
  };


  myStack.homepageServices."Productivity" = [{
    name = "Wealthfolio";
    href = "https://wealthfolio.toscanini.me";
    description = "Personal finance";
    icon = "mdi-finance-#34d399";
    siteMonitor = "http://host.containers.internal:8088";
  }];

  virtualisation.oci-containers.containers.wealthfolio = mkRootlessContainer {
    image = "docker.io/afadil/wealthfolio:latest";

    ports = [ "8088:8088" ];

    volumes = [
      "/home/santiago/selfhost/wealthfolio/data:/data"
    ];

    # WF_LISTEN_ADDR + WF_DB_PATH + WF_SECRET_KEY + WF_AUTH_PASSWORD_HASH
    # + WF_CORS_ALLOW_ORIGINS.
    environmentFiles = [ "/etc/nixos/stacks/wealthfolio/secrets/env" ];
  };
}
