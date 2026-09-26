# Declarative Pocket ID OIDC clients — `fleet.ssoClients.<name>`.
#
# Both halves of a client credential originate on this box: the client ID
# is a plain nix string (the attr name), and the secret is generated here
# the first time a client is declared. Pocket ID accepts a
# caller-supplied `id` on `POST /api/oidc/clients` and a caller-supplied
# `secret` on `POST /api/oidc/clients/{id}/secrets` — the singular
# `/secret` it was until v2.13.0 — so nothing has to be minted by the
# server and pasted back. A fresh `pocket_id` database re-converges on
# the next boot instead of needing every client recreated by hand.
#
# ── the secret is machine-generated, not operator state ────────────────
#
# `sso-client-secrets.service` ensures one 64-hex key per declared client
# in a dotenv file under this stack's state dir, and generates the ones
# that are missing. Same class as the app-db cluster password and each
# app's AUTH_SECRET: born on the box, never in git, rotated by deleting
# the key and rebuilding.
#
# Don't move it back to operator state (a tracked sops file per key): that
# makes declaring a client a two-step act, and since the render below is
# ONE unit for every client, a forgotten second step fails the login path
# for all of them at activation. Nothing about a random 32-byte string
# wants a human in the loop.
#
# Losing the state file costs nothing but a rotation. The sync pushes
# our secret to the IdP on every boot — adding it and pruning whatever
# it supersedes, see assets/sync-clients.sh — so a regenerated one
# converges there, and every consumer reads the same file through the
# renders below. That is what makes generating it safe where an app's
# data would not be. The one manual step after a rotation is bouncing
# traefik, which holds the forward-auth secret in memory.
#
# Two consumer shapes, both fed from the same secret:
#
#   traefikForwardAuth = true
#     The client belongs to traefik's generated `oidc-<name>` middleware
#     (modules/traefik). Its creds are rendered into `sso.clientEnvFile`
#     as POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET} — the variable names the
#     middleware YAML interpolates at request time.
#
#   consumers = [ "<container>" ]
#     The app speaks OIDC itself. Each listed container gets
#     `/run/sso-clients/<name>-env` appended to its environmentFiles by
#     this module — consumers never read the path back out of `config`,
#     which would recurse through the apps stack's fragment assembly. The
#     variable names in that file are `consumerEnv` (every image spells
#     the pair differently: GF_AUTH_GENERIC_OAUTH_CLIENT_*,
#     VERDACCIO_OPENID_CLIENT_*, GENERIC_CLIENT_*, …).
#
# Forward-auth clients are NOT written by hand: every
# `fleet.webApps.<n>.auth = "oidc"` entry auto-derives one, since that
# option already says "this hostname is gated by Pocket ID" and the
# client is just its other half. Group restriction rides
# `webApps.<n>.authGroups`. Declaring `fleet.ssoClients.<n>` by hand is
# for native-OIDC apps and anything that isn't a webApp at all.
#
# Logos are convention, not configuration: a catalog module sets `logo` on
# its own client; a host drops `<name>.png` (or .svg) for the clients of its
# own stacks into `fleet.sso.logoDir`; the sync uploads either to a client
# that has none.
# Without that the "repo IS the system" claim would have a visible hole
# — a rebuilt IdP would serve a My Apps page of blank tiles.
#
# The convergence oneshot is deliberately NOT ordered before traefik:
# ingress must not wait on IdP convergence. The cost is a few seconds on
# a cold boot where a gated app's middleware has creds for a client the
# IdP doesn't know yet (fresh DB only — clients persist).
#
# Rotating a secret: delete its line from the state file and rebuild. The
# generator mints a new one, the sync pushes it to the IdP and the renders
# hand the same value to the consumers, so all three move together —
# though a consumer holding the old secret in memory needs a restart.

{
  config,
  lib,
  pkgs,
  mkSecretRender,
  ...
}:

let
  cfg = config.fleet.ssoClients;

  # `POCKET_OIDC_<NAME>_CLIENT_ID` / `SSO_SECRET_<NAME>` — the same
  # uppercase-and-de-hyphenate mapping traefik's generator uses.
  envName = n: lib.toUpper (lib.replaceStrings [ "-" ] [ "_" ] n);
  secretKey = n: "SSO_SECRET_${envName n}";

  # Machine-generated, one key per client, in the state tree rather than any
  # checkout. Not in /run: it has to survive a reboot,
  # or every client would rotate on every boot.
  secretsFile = "${stateDir}/client-secrets.env";
  stateDir = "${config.fleet.stateRoot}/pocket-id/secrets";

  secretsUnit = "sso-client-secrets.service";

  # One unit for every client, and its ExecStart embeds the key list — so
  # declaring a client changes the unit and systemd re-runs it on the
  # rebuild that declares it, which is what makes "add a client and it
  # works" true without a second step.
  #
  # Existing keys are never touched. That is the whole contract: this is
  # ensure-exists, not converge, because rewriting a live secret would
  # log every user of that client out at an unpredictable moment.
  secretsScript = pkgs.writeShellApplication {
    name = "sso-client-secrets";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
    ];
    # Body at assets/client-secrets.sh, same arrangement as the sync below.
    text = ''
      FILE=${lib.escapeShellArg secretsFile}
      STATE_DIR=${lib.escapeShellArg stateDir}
      OPERATOR_USER=${lib.escapeShellArg config.fleet.operator.user}
      OPERATOR_GROUP=${lib.escapeShellArg config.fleet.operator.group}
      KEYS=${lib.escapeShellArg (lib.concatStringsSep " " (map secretKey (lib.attrNames cfg)))}

      ${builtins.readFile ./assets/client-secrets.sh}
    '';
  };

  # NOT /run/<container-name>: systemd wipes a RuntimeDirectory named
  # after a unit when that unit stops, which silently empties the
  # rendered file underneath a running consumer.
  inherit (config.fleet.sso) renderDir;
  clientEnvFile = n: "${renderDir}/${n}-env";
  # Declared by the platform (fleet.sso.clientEnvFile), non-null exactly when
  # forwardAuthClients is non-empty — the only branch that reads this.
  traefikEnvFile = config.fleet.sso.clientEnvFile;

  forwardAuthClients = lib.filterAttrs (_: c: c.traefikForwardAuth) cfg;

  # Non-secret desired state. The script does the HTTP; nix does the
  # shape — same split as the apps platform's deploy oneshot.
  manifest = pkgs.writeText "sso-clients.json" (
    builtins.toJSON (
      lib.mapAttrsToList (n: c: {
        key = n;
        id = n;
        secretKey = secretKey n;
        groups = c.allowedGroups;
        inherit (c) logo;
        logoType =
          if c.logo != null && lib.hasSuffix ".svg" (toString c.logo) then "image/svg+xml" else "image/png";
        body = {
          name = c.displayName;
          inherit (c) description;
          inherit (c) callbackURLs;
          inherit (c) logoutCallbackURLs;
          # Every client here is CONFIDENTIAL, and that is a claim about the
          # app, not just a field: Pocket ID will demand client
          # authentication at the token endpoint, so an app that does not
          # send its secret gets `invalid_client` at the exchange — after a
          # redirect and a callback that both looked fine. Give any native
          # OIDC app `consumers = [ "<container>" ]` + the `consumerEnv.secret`
          # name its image reads.
          #
          # A hand-made PUBLIC client overwritten by the sync once broke an
          # app's login this way, invisibly for thirteen days, because
          # nothing logs in on a schedule.
          #
          # PKCE below is not the alternative to a secret. The secret proves
          # which client is asking; PKCE proves it is the same party that
          # started the flow. Confidential clients here run both.
          isPublic = false;
          pkceEnabled = c.pkce;
          inherit (c) skipConsent;
          requiresReauthentication = false;
          isGroupRestricted = c.allowedGroups != [ ];
        }
        // lib.optionalAttrs (c.launchURL != null) { inherit (c) launchURL; };
      }) cfg
    )
  );

  syncScript = pkgs.writeShellApplication {
    name = "pocket-id-clients-sync";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.jq
      pkgs.podman
    ];
    text = ''
      MANIFEST=${manifest}
      IDP_ENV=${config.sops.secrets."pocket-id-env".path}
      SECRETS=${secretsFile}
      # Statically linked (musl), so it runs in the IdP's container
      # whatever that image happens to contain. See sync-clients.sh.
      CURL_BIN=${pkgs.pkgsStatic.curl}/bin/curl

      ${builtins.readFile ./assets/sync-clients.sh}
    '';
  };

  # `grep | cut` per client, into shell vars the heredoc interpolates.
  # Rendered files carry the secret; the /nix/store script carries only
  # variable names.
  extractSecret = n: ''
    SECRET_${envName n}=$(grep '^${secretKey n}=' ${secretsFile} | head -1 | cut -d= -f2-)
    [ -n "$SECRET_${envName n}" ] || { echo "${secretKey n} missing from ${secretsFile}" >&2; exit 1; }
  '';
in
{

  # `fleet.ssoClients` and `fleet.sso.*` are declared by the platform
  # (identity.nix); this file is their implementation.
  config = lib.mkIf config.fleet.modules.pocket-id.enable (
    lib.mkMerge [

      # Every oidc-gated webApp IS a client — derived, not restated. The
      # middleware traefik generates for `auth = "oidc"` is useless without
      # a client at the IdP, so the two are one decision.
      {
        # What the client IS — the URLs and the group restriction — is
        # derived here, because all of it is already stated by the webApp.
        # What the client is CALLED is not: `displayName` and `description`
        # are the consent screen's copy, they have no mechanical source, and
        # the stack that owns the service is the only thing that knows them.
        # Each one sets them on its own `fleet.ssoClients.<n>` entry, which
        # merges with this; the submodule's defaults (sentence-cased attr
        # key, no subtitle) apply to anything that does not bother.
        fleet.ssoClients = lib.mapAttrs (_: w: {
          launchURL = "https://${w.hostname}";
          # Aliases too: a renamed app's old address still signs in until the
          # rename is confirmed and the alias dropped (webApps.<n>.aliases).
          callbackURLs = map (h: "https://${h}/oidc/callback") ([ w.hostname ] ++ w.aliases);
          logoutCallbackURLs = map (h: "https://${h}/oidc/callback") ([ w.hostname ] ++ w.aliases);
          allowedGroups = w.authGroups;
          traefikForwardAuth = true;
        }) (lib.filterAttrs (_: w: w.auth == "oidc") config.fleet.webApps);
      }

      {
        # What nix DECLARES, for daedalus's declared-vs-live diff. The sync
        # above converges but never prunes, so a deleted stack's client stays
        # live at the IdP forever — and diffing this list against the IdP's is
        # the only way to see one. Non-secret facts only: the id (the attr
        # name) and the display name.
        fleet.export.domains.sso.data.clients = lib.mapAttrsToList (n: c: {
          id = n;
          inherit (c) displayName;
        }) cfg;

        fleet.statePaths = {
          ${stateDir}.mode = "0700";
          ${secretsFile} = {
            type = "f";
            mode = "0600";
          };
        };

        systemd.services.sso-client-secrets = lib.mkIf (cfg != { }) {
          description = "Generate the Pocket ID client secret for every fleet.ssoClients entry";
          # The state tree may be its own (ZFS) mount, and the renders that
          # read this file are ordered after it rather than the other way
          # round.
          after = [ "local-fs.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            ExecStart = "${secretsScript}/bin/sso-client-secrets";
          };
        };

        assertions = lib.mapAttrsToList (n: c: {
          assertion = c.traefikForwardAuth -> (config.fleet.webApps.${n}.auth or "none") == "oidc";
          message = ''
            fleet.ssoClients.${n}: `traefikForwardAuth` is set but
            fleet.webApps.${n}.auth is not "oidc" — the creds would be
            rendered for a middleware that is never generated.
          '';
        }) cfg;

        systemd.services.pocket-id-clients = lib.mkIf (cfg != { }) {
          description = "Converge Pocket ID OIDC clients from fleet.ssoClients";
          after = [
            "podman-pocket-id.service"
            secretsUnit
          ];
          wants = [
            "podman-pocket-id.service"
            secretsUnit
          ];
          wantedBy = [ "multi-user.target" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
            Restart = "on-failure";
            RestartSec = "15s";
            # Bounded: the whole point of not gating traefik on this is
            # that a sick IdP must not become an ingress outage, and a
            # hung unit at boot would do exactly that by another route.
            TimeoutStartSec = 120;
            User = config.fleet.operator.user;
            Environment = "XDG_RUNTIME_DIR=${config.fleet.operator.runtimeDir}";
            ExecStart = "${syncScript}/bin/pocket-id-clients-sync";
          };
        };
      }

      # Forward-auth creds for traefik — one file, every such client.
      (lib.mkIf (forwardAuthClients != { }) {
        systemd.services.sso-traefik-env-render = mkSecretRender {
          description = "Render Pocket ID forward-auth client creds for traefik";
          gates = [ "podman-traefik.service" ];
          dir = renderDir;
          file = traefikEnvFile;
          # Unlike a /run/secrets path, this one is written by a unit rather
          # than by activation, so the ordering has to be said out loud.
          after = [ secretsUnit ];
          wants = [ secretsUnit ];
          prep = lib.concatMapStrings extractSecret (lib.attrNames forwardAuthClients);
          content = lib.concatStringsSep "\n" (
            lib.concatMap (n: [
              "POCKET_OIDC_${envName n}_CLIENT_ID=${n}"
              "POCKET_OIDC_${envName n}_CLIENT_SECRET=\$SECRET_${envName n}"
            ]) (lib.attrNames forwardAuthClients)
          );
        };
      })

      # Per-client creds for native-OIDC consumers, under whatever
      # variable names that image reads.
      {
        systemd.services = lib.mapAttrs' (
          n: c:
          lib.nameValuePair "sso-${n}-env-render" (mkSecretRender {
            description = "Render the Pocket ID client creds for ${n}";
            gates = map (unit: "podman-${unit}.service") c.consumers;
            dir = renderDir;
            file = clientEnvFile n;
            after = [ secretsUnit ];
            wants = [ secretsUnit ];
            prep = extractSecret n;
            content = lib.concatStringsSep "\n" (
              lib.optional (c.consumerEnv.id != null) "${c.consumerEnv.id}=${n}"
              ++ [ "${c.consumerEnv.secret}=\$SECRET_${envName n}" ]
            );
          })
        ) (lib.filterAttrs (_: c: c.consumers != [ ]) cfg);
      }

      # The env file lands on the consumer container from HERE rather than
      # from the consumer's own module: the apps stack would have to read
      # `config.fleet.ssoClients.<name>` back while defining it, which
      # forces its fragment assembly mid-evaluation (infinite recursion —
      # see the assembly note at the bottom of the apps stack).
      {
        virtualisation.oci-containers.containers = lib.mkMerge (
          lib.concatMap (
            n: map (unit: { ${unit}.environmentFiles = [ (clientEnvFile n) ]; }) cfg.${n}.consumers
          ) (lib.attrNames cfg)
        );
      }
    ]
  );
}
