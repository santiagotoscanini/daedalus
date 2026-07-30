# pocket-id — OIDC identity provider (passkey-only) for the box-wide
# SSO (see /etc/nixos/AUTH.md). Every service that can speak OIDC
# authenticates against this; everything else sits behind a traefik
# forward-auth middleware that itself authenticates here.
#
# Single Go binary. State is split across two places — BOTH matter for
# recovery:
#   - DB (users, clients, credentials, audit log) on the shared app-db
#     cluster (`fleet.appDatabases.pocket_id` below) — covered by the
#     cluster's backup story.
#   - /app/data (~/selfhost/pocket-id/data) holds only the OIDC signing
#     keys, encrypted at rest with ENCRYPTION_KEY (env.sops) — the app
#     refuses to start without it. Rotating ENCRYPTION_KEY requires
#     re-encrypting stored keys, so treat it as fixed once set.
#
# First-boot setup is INTERACTIVE — open https://id.toscanini.me/setup
# once to create the admin account and register a passkey; there is no
# seed/env bootstrap.
#
# Passkey-only by design: EMAIL_ONE_TIME_ACCESS_* stays unset (off).
# Recovery if all passkeys are lost: `pocket-id one-time-access-token
# <user>` inside the container mints a login link from the CLI.
#
# exposeRemotely: the IdP must be reachable through the CF tunnel —
# remote-exposed apps (nextcloud, immich, grocy, wealthfolio, anansi)
# redirect here for login from off-LAN. APP_URL pins absolute URLs to
# https regardless of the plain-HTTP cfweb entrypoint.
#
# The entrypoint drops to in-container UID 1000 → host 100999
# (hostUid 1000), which owns /app/data. Listens on 1411 (v2 port).

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

{
  # Declared here (owning-module convention): the IdP's issuer URL,
  # consumed by every OIDC client on the box (traefik middlewares,
  # grafana, gatus, litellm, n8n, wealthfolio) so the hostname is
  # written once.
  options.fleet.sso.issuerUrl = lib.mkOption {
    type = lib.types.str;
    default = "https://${config.fleet.webApps.pocket-id.hostname}";
    defaultText = lib.literalExpression ''"https://''${fleet.webApps.pocket-id.hostname}"'';
    description = "OIDC issuer URL of the box-wide IdP (Pocket ID).";
  };

  config = {
    # ENCRYPTION_KEY: sops-encrypted env.sops, decrypted to
    # /run/secrets/pocket-id-env at activation. Edit with `sops env.sops`.
    sops.secrets."pocket-id-env" = mkDotenvSecret ./env.sops;

    # Readiness gate, mirroring podman-pg's: "podman-pocket-id finished"
    # only means `podman run -d` returned — the IdP answers HTTP a moment
    # later. ExecStartPost holds the unit (and every OIDC consumer ordered
    # after it: verdaccio, wealthfolio) until the app's own healthcheck
    # passes, so first-attempt discovery can't race a cold boot.
    systemd.services.podman-pocket-id.serviceConfig.ExecStartPost =
      # 120s: generous because a mass restart (a podman.nix change touches
      # every unit) starts the whole fleet at once and the IdP competes
      # for CPU with ~50 containers.
      pkgs.writeShellScript "wait-pocket-id-ready" ''
        for _ in $(seq 1 120); do
          ${pkgs.podman}/bin/podman exec pocket-id /app/pocket-id healthcheck && exit 0
          sleep 1
        done
        echo "pocket-id did not become ready within 120s" >&2
        exit 1
      '';

    fleet.bridgeMemberships.pocket-id = [
      "traefik"
      "app-db"
    ];

    # Database on the shared app-db cluster (db/role `pocket_id` —
    # hyphens aren't valid there). DB_CONNECTION_STRING rides the
    # bootstrap env file.
    fleet.appDatabases.pocket_id.consumers = [ "pocket-id" ];

    fleet.webApps.pocket-id = {
      hostname = "id.toscanini.me";
      serviceName = "pocket-id";
      port = 1411;
      exposeRemotely = true;
      homepage = {
        group = "Network";
        name = "Pocket ID";
        description = "OIDC provider — passkey SSO for all web UIs";
        icon = "pocket-id.png";
      };
    };

    fleet.statePaths = {
      "/home/santiago/selfhost/pocket-id" = { };
      "/home/santiago/selfhost/pocket-id/data" = {
        uid = 1000;
        mode = "0700";
      };
    };

    virtualisation.oci-containers.containers.pocket-id = mkRootlessContainer {
      image = "ghcr.io/pocket-id/pocket-id:v2.12.0@sha256:4a277d141d6069fd9a7b321a9aca80f4b9812b8fa122ee566d2f15900e3d8448";

      volumes = [
        "/home/santiago/selfhost/pocket-id/data:/app/data"
      ];

      environmentFiles = [
        config.sops.secrets."pocket-id-env".path
        config.fleet.appDatabases.pocket_id.envFile
      ];

      environment = {
        DB_PROVIDER = "postgres";
        APP_URL = config.fleet.sso.issuerUrl;
        ANALYTICS_DISABLED = "true";
        # Traefik fronts everything; without this the audit log records
        # the bridge IP instead of the real client.
        TRUST_PROXY = "true";
        # Stay signed in for 24h before a passkey is required again
        # (default 60 min). Every app SSO within this window is silent.
        SESSION_DURATION = "1440";
      };

    };
  };
}
