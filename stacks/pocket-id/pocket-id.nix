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

  options.fleet.sso.discoveryConsumers = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    default = [ ];
    description = ''
      Container names that fetch the OIDC discovery document while
      starting up and cannot recover if it isn't being served yet —
      they either panic (gatus, zot) or silently come up with OIDC
      login broken until a restart (verdaccio, wealthfolio). Under
      `--rm` a crash leaves the oneshot unit green with no container
      behind it, so the failure is invisible.

      Each listed container is ordered behind traefik and the IdP, and
      blocked by a bounded probe of the real discovery URL. Ordering
      alone is not enough: it only proves `podman run -d` returned, and
      the request path that actually matters runs through traefik.

      Registration is opt-in — an app that fetches discovery lazily
      (shelfmark) or re-tries on its own doesn't need it.
    '';
    example = lib.literalExpression ''[ "gatus" "zot" ]'';
  };

  config = lib.mkMerge [
    {
      # ENCRYPTION_KEY: sops-encrypted env.sops, decrypted to
      # /run/secrets/pocket-id-env at activation. Edit with `sops env.sops`.
      sops.secrets."pocket-id-env" = mkDotenvSecret ./env.sops;

      # A consumer must never be listed as its own prerequisite, and the
      # IdP obviously can't wait for its own discovery endpoint.
      assertions = [
        {
          assertion = !(lib.elem "pocket-id" config.fleet.sso.discoveryConsumers);
          message = "fleet.sso.discoveryConsumers must not contain \"pocket-id\" — the IdP cannot gate on itself.";
        }
      ];

      # Readiness gate, mirroring podman-pg's: "podman-pocket-id finished"
      # only means `podman run -d` returned — the IdP answers HTTP a moment
      # later. ExecStartPost holds the unit (and everything ordered after
      # it) until the app's own healthcheck passes, so first-attempt
      # discovery can't race a cold boot.
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

      # Unwedges the scheduler's expired-data cleanup, which self-blocks on
      # a stale marker encoding — see assets/repair-cleanup-marker.sql for
      # the mechanism. Idempotent, so it stays harmless once repaired.
      # Ordered before pocket-id (weakly: a failed repair must not be able
      # to take SSO down with it) and run as the tenant role that owns the
      # table, not the cluster superuser.
      systemd.services.pocket-id-cleanup-marker-repair = {
        description = "Repair pocket-id's francis_metadata last-cleanup marker";
        before = [ "podman-pocket-id.service" ];
        wantedBy = [ "podman-pocket-id.service" ];
        after = [
          "podman-pg.service"
          "app-db-pocket_id-bootstrap.service"
        ];
        wants = [ "podman-pg.service" ];
        path = [
          pkgs.coreutils
          pkgs.gnugrep
          pkgs.podman
        ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          User = "santiago";
          Environment = "XDG_RUNTIME_DIR=/run/user/1000";
        };
        # PGPASSWORD rides a value-less -e passthrough so the secret never
        # sits in podman argv (/proc/<pid>/cmdline).
        script = ''
          set -eu
          APP_PWD=$(grep '^POSTGRES_PASSWORD=' ${config.fleet.appDatabases.pocket_id.envFile} | head -1 | cut -d= -f2-)
          [ -n "$APP_PWD" ] || { echo "empty POSTGRES_PASSWORD for pocket_id" >&2; exit 1; }
          PGPASSWORD="$APP_PWD" podman exec -i -e PGPASSWORD pg \
            psql -X -v ON_ERROR_STOP=1 -U pocket_id -d pocket_id \
            < ${./assets/repair-cleanup-marker.sql}
        '';
      };

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
          APP_URL = config.fleet.sso.issuerUrl;
          ANALYTICS_DISABLED = "true";
          # Traefik fronts everything; without this the audit log records
          # the bridge IP instead of the real client.
          TRUST_PROXY = config.fleet.bridgeSubnets.traefik;
          # Session length (24h, so every app SSO inside that window is
          # silent) is DB state — `sessionDuration` in the pocket_id
          # database, set through the admin UI. Pocket ID reads the
          # UI-configurable keys from the environment only when
          # UI_CONFIG_DISABLED=true, which we do not set, so declaring
          # SESSION_DURATION here would be inert.
        };

      };
    }

    # The generated gate for every fleet.sso.discoveryConsumers entry.
    # `after` gets the IdP's own ExecStartPost readiness gate; the
    # ExecStartPre then proves the full path the consumer actually uses
    # (through traefik, wildcard TLS), which is what returns 502 mid-boot
    # while the IdP itself is already healthy. Bounded at ~120s so a
    # genuinely-down IdP fails the unit VISIBLY — container_up and
    # scrape-target-down both fire — instead of going green-dead.
    {
      systemd.services = lib.listToAttrs (
        map (
          name:
          lib.nameValuePair "podman-${name}" {
            after = [
              "podman-traefik.service"
              "podman-pocket-id.service"
            ];
            wants = [
              "podman-traefik.service"
              "podman-pocket-id.service"
            ];
            # mkAfter: must run after mkRootlessContainer's own pre-start.
            serviceConfig.ExecStartPre = lib.mkAfter [
              "${pkgs.writeShellScript "${name}-wait-oidc" ''
                url="${config.fleet.sso.issuerUrl}/.well-known/openid-configuration"
                for _ in $(seq 1 60); do
                  ${pkgs.curl}/bin/curl -fsS --max-time 5 -o /dev/null "$url" && exit 0
                  sleep 2
                done
                echo "${name}: OIDC discovery ($url) not ready after ~120s" >&2
                exit 1
              ''}"
            ];
          }
        ) config.fleet.sso.discoveryConsumers
      );
    }
  ];
}
