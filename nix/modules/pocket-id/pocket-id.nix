# pocket-id — OIDC identity provider (passkey-only) for the box-wide SSO.
# Every service that can speak OIDC authenticates against this; everything
# else sits behind a reverse-proxy forward-auth middleware that itself
# authenticates here. The interface it implements — `fleet.sso.*` and
# `fleet.ssoClients` — is the platform's (platform/identity.nix); this
# directory is the provider (this file) and the client convergence
# (clients.nix), two files listed one by one in flake.nix and in a host's
# import list, in that order.
#
# Single Go binary. State is split across two places — BOTH matter for
# recovery:
#   - DB (users, clients, credentials, audit log) on the shared app-db
#     cluster (`fleet.appDatabases.pocket_id` below) — covered by the
#     cluster's backup story.
#   - /app/data (<stateRoot>/pocket-id/data) holds only the OIDC signing
#     keys, encrypted at rest with ENCRYPTION_KEY (the host's env file) —
#     the app refuses to start without it. Rotating ENCRYPTION_KEY requires
#     re-encrypting stored keys, so treat it as fixed once set.
#
# First-boot setup is INTERACTIVE — open https://<hostname>/setup once to
# create the admin account and register a passkey; there is no seed/env
# bootstrap.
#
# Passkey-only by design: EMAIL_ONE_TIME_ACCESS_* stays unset (off).
# Recovery if all passkeys are lost: `pocket-id one-time-access-token
# <user>` inside the container mints a login link from the CLI.
#
# exposeRemotely (an option, off by default): an app published off-LAN
# redirects here for its login, so the provider has to be reachable through
# the tunnel too — the assertion below says so when it is not. APP_URL pins
# absolute URLs to https regardless of the plain-HTTP tunnel entrypoint.
#
# The entrypoint drops to in-container UID 1000 → host 100999
# (hostUid 1000), which owns /app/data. Listens on 1411 (v2 port).
#
# The host brings:
#   fleet.modules.pocket-id.enable          the switch (default off, as every catalog module)
#   fleet.modules.pocket-id.envSopsFile     ENCRYPTION_KEY (+ STATIC_API_KEY for the control plane)
#   fleet.modules.pocket-id.exposeRemotely  reachable through the tunnel (default false)
#   fleet.images.pocket-id                  the digest-pinned image
#   fleet.sso.logoDir                       logos for the clients of the host's own stacks (optional)
#   fleet.webApps.pocket-id.hostname        to publish under another label than `id` (optional)
# Requires the reverse proxy and the shared cluster (asserted).

{
  config,
  lib,
  pkgs,
  mkRootlessContainer,
  mkDotenvSecret,
  mkSecretRender,
  pinnedImage,
  ...
}:

let
  cfg = config.fleet.modules.pocket-id;

  # What this stack hands the control plane (fleet.dashboard, platform/
  # export.nix): the read-only API key daedalus's IdP page reads with, copied
  # out of the host's env file by a render THIS stack owns — the control plane
  # never greps another stack's secret. Not /run/app-daedalus: that is the
  # container unit's RuntimeDirectory, wiped when the container stops.
  dashboardDir = "/run/pocket-id-daedalus";

  # Apps published off-LAN that log in here. If any exists the provider has
  # to be reachable the same way, or their login redirect dead-ends.
  remoteGatedApps = lib.attrNames (
    lib.filterAttrs (
      n: w: n != "pocket-id" && w.auth == "oidc" && w.exposeRemotely
    ) config.fleet.webApps
  );
in
{
  options.fleet.modules.pocket-id = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Pocket ID — the box-wide OIDC identity provider, and its declared clients.";
    };

    envSopsFile = lib.mkOption {
      type = lib.types.path;
      example = lib.literalExpression "./host/sops/pocket-id/env.sops";
      description = ''
        sops-encrypted dotenv carrying ENCRYPTION_KEY (the at-rest key of the
        OIDC signing keys — fixed once set) and, for a host that runs the
        control plane, STATIC_API_KEY (a read-only API key its identity page
        reads with). Host data: the engine carries no box's ciphertext. Only
        read while the module is on.
      '';
    };

    exposeRemotely = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Publish the provider through the tunnel as well as on the LAN.
        Required as soon as any `auth = "oidc"` app is itself
        `exposeRemotely` — its login redirects here — and asserted so.
        Off by default: declaring a provider must not widen the box's
        public surface by itself.
      '';
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        assertions = [
          # A consumer must never be listed as its own prerequisite, and the
          # IdP obviously can't wait for its own discovery endpoint.
          {
            assertion = !(lib.elem "pocket-id" config.fleet.sso.discoveryConsumers);
            message = "fleet.sso.discoveryConsumers must not contain \"pocket-id\" — the IdP cannot gate on itself.";
          }
          {
            assertion = config.fleet.modules.traefik.enable;
            message = "fleet.modules.pocket-id: the provider is published through the reverse proxy and trusts its bridge — enable fleet.modules.traefik.";
          }
          {
            assertion = config.fleet.modules.app-db.enable;
            message = "fleet.modules.pocket-id: the provider's database lives on the shared cluster — enable fleet.modules.app-db.";
          }
          {
            assertion = cfg.exposeRemotely || remoteGatedApps == [ ];
            message = "fleet.modules.pocket-id: ${lib.concatStringsSep ", " remoteGatedApps} are gated and published off-LAN, so their login redirects here — set fleet.modules.pocket-id.exposeRemotely.";
          }
        ];

        # ENCRYPTION_KEY: the host's sops-encrypted dotenv, decrypted to
        # /run/secrets/pocket-id-env at activation.
        sops.secrets."pocket-id-env" = mkDotenvSecret cfg.envSopsFile;

        # For the control plane's IdP page. The version it shows is the image tag
        # from /export/images.json (Pocket ID has no /api/version). STATIC_API_KEY is
        # the read-only key minted for daedalus; it stays in THIS stack's
        # env.sops (nothing in the secret tree exists twice) and reaches the
        # app as DASH_POCKETID_KEY through the render below, `grep -m1` so a
        # missing key renders empty and the panel says "no data" instead of
        # taking the page down.
        fleet.dashboard.pocket-id = {
          envFiles = [ "${dashboardDir}/env" ];
        };
        systemd.services.pocket-id-daedalus-key =
          lib.mkIf config.fleet.modules.daedalus.enable
            (mkSecretRender {
              description = "Render Pocket ID's read-only API key for daedalus";
              gates = [ "podman-app-daedalus.service" ];
              dir = dashboardDir;
              file = "${dashboardDir}/env";
              prep = "KEY=$(grep -m1 '^STATIC_API_KEY=' ${
                config.sops.secrets."pocket-id-env".path
              } | cut -d= -f2- || true)";
              content = "DASH_POCKETID_KEY=$KEY";
            });

        # Readiness gate, mirroring podman-pg's: "podman-pocket-id finished"
        # only means `podman run -d` returned — the IdP answers HTTP a moment
        # later. ExecStartPost holds the unit (and everything ordered after
        # it) until the app's own healthcheck passes, so first-attempt
        # discovery can't race a cold boot.
        systemd.services.podman-pocket-id.serviceConfig.ExecStartPost =
          # 120s: generous because a mass restart (a podman.nix change touches
          # every unit) starts the whole fleet at once and the IdP competes
          # for CPU with ~50 containers.
          #
          # Don't raise it for schema migrations: a migrating version jump
          # (v2.14.0 → v2.16.0) answered in two seconds, and a longer gate is
          # worse in the real failure — a pocket-id that cannot start at all
          # then holds the switch for ten minutes per attempt instead of two.
          pkgs.writeShellScript "wait-pocket-id-ready" ''
            for _ in $(seq 1 120); do
              ${pkgs.podman}/bin/podman exec pocket-id /app/pocket-id healthcheck && exit 0
              sleep 1
            done
            echo "pocket-id did not become ready within 120s" >&2
            exit 1
          '';

        # An update to the IdP takes the whole box's login with it, and —
        # unlike every other container here — it cannot simply be put back:
        # a newer pocket-id migrates the schema on first start and the older
        # one then refuses it outright. That makes the updater's own revert
        # unavailable exactly when it is most wanted, which is the blast
        # radius the container's name does not carry. The Updates panel
        # therefore asks for the name to be typed before this one moves.
        #
        # The failure that earned it was not pocket-id's: it updated cleanly
        # inside a batch, another container failed verification, the updater
        # reverted the whole batch, and pocket-id could not go back — every
        # login lost over an unrelated container. Ceremony is about never
        # letting it ride in a batch whose revert it cannot survive.
        fleet.imageUpdates.pocket-id.ceremony = "every login on the box rides it, and a downgrade is refused: a newer pocket-id migrates the database on first start, so the updater cannot revert this one — the only way back is forward";

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
            User = config.fleet.operator.user;
            Environment = "XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir}";
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
          # `id` is the conventional label for a provider; a host that wants
          # another defines `fleet.webApps.pocket-id.hostname` itself.
          hostname = lib.mkDefault "id.${config.fleet.baseDomain}";
          serviceName = "pocket-id";
          port = 1411;
          inherit (cfg) exposeRemotely;
        };

        fleet.statePaths = {
          "${config.fleet.stateRoot}/pocket-id" = { };
          "${config.fleet.stateRoot}/pocket-id/data" = {
            uid = 1000;
            mode = "0700";
          };
        };

        virtualisation.oci-containers.containers.pocket-id = mkRootlessContainer {
          image = pinnedImage "pocket-id" "ghcr.io/pocket-id/pocket-id";

          volumes = [
            "${config.fleet.stateRoot}/pocket-id/data:/app/data"
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
            # `or`: with the proxy off the subnet is undefined, and the assertion
            # above should be what says so, not an attribute error here.
            TRUST_PROXY = config.fleet.bridgeSubnets.traefik or "";
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
    ]
  );
}
