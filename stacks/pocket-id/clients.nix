# Declarative Pocket ID OIDC clients — `fleet.ssoClients.<name>`.
#
# Both halves of a client credential originate in this repo: the client
# ID is a plain nix string (the attr name), and the secret is one key in
# `clients.sops`. Pocket ID >= 2.12.0 accepts a caller-supplied `id` on
# `POST /api/oidc/clients` and a caller-supplied `secret` on
# `POST /api/oidc/clients/{id}/secret`, so nothing has to be minted by
# the server and pasted back. A fresh `pocket_id` database re-converges
# on the next boot instead of needing every client recreated by hand.
#
# Two consumer shapes, both fed from the same secret:
#
#   traefikForwardAuth = true
#     The client belongs to traefik's generated `oidc-<name>` middleware
#     (stacks/traefik). Its creds are rendered into `sso.clientEnvFile`
#     as POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET} — the variable names the
#     middleware YAML interpolates at request time.
#
#   consumers = [ "<container>" ]
#     The app speaks OIDC itself. Each listed container gets
#     `/run/sso-clients/<name>-env` appended to its environmentFiles by
#     this module — consumers never read the path back out of `config`,
#     which would recurse through stacks/apps' fragment assembly. The
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
# Logos are convention, not configuration: drop `<name>.png` (or .svg)
# into assets/logos/ and the sync uploads it to a client that has none.
# Without that the "repo IS the system" claim would have a visible hole
# — a rebuilt IdP would serve a My Apps page of blank tiles.
#
# The convergence oneshot is deliberately NOT ordered before traefik:
# ingress must not wait on IdP convergence. The cost is a few seconds on
# a cold boot where a gated app's middleware has creds for a client the
# IdP doesn't know yet (fresh DB only — clients persist).
#
# Rotating a secret: `sops clients.sops`, rebuild. The oneshot pushes
# the new value to the IdP and the renders hand the same value to the
# consumers, so both sides move together.

{
  config,
  lib,
  pkgs,
  mkDotenvSecret,
  mkSecretRender,
  ...
}:

let
  cfg = config.fleet.ssoClients;

  # `POCKET_OIDC_<NAME>_CLIENT_ID` / `SSO_SECRET_<NAME>` — the same
  # uppercase-and-de-hyphenate mapping traefik's generator uses.
  envName = n: lib.toUpper (lib.replaceStrings [ "-" ] [ "_" ] n);
  secretKey = n: "SSO_SECRET_${envName n}";

  secretsFile = config.sops.secrets."sso-client-secrets".path;

  # NOT /run/<container-name>: systemd wipes a RuntimeDirectory named
  # after a unit when that unit stops, which silently empties the
  # rendered file underneath a running consumer.
  renderDir = "/run/sso-clients";
  clientEnvFile = n: "${renderDir}/${n}-env";
  traefikEnvFile = "${renderDir}/traefik-env";

  forwardAuthClients = lib.filterAttrs (_: c: c.traefikForwardAuth) cfg;

  # Non-secret desired state. The script does the HTTP; nix does the
  # shape — same split as the deploy oneshot in stacks/apps.
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
  options.fleet.ssoClients = lib.mkOption {
    default = { };
    description = ''
      Pocket ID OIDC clients, converged by `pocket-id-clients.service`.
      The attr name IS the OIDC client_id; the secret is
      `SSO_SECRET_<NAME>` in stacks/pocket-id/clients.sops.
    '';
    type = lib.types.attrsOf (
      lib.types.submodule (
        { name, ... }:
        {
          options = {
            displayName = lib.mkOption {
              type = lib.types.str;
              default = lib.toSentenceCase name;
              description = "Name on the consent screen, the My Apps page and the audit log.";
            };
            description = lib.mkOption {
              type = lib.types.str;
              default = "";
              description = "Subtitle on the Pocket ID My Apps page.";
            };
            launchURL = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Where the My Apps tile points. null omits the field.";
            };
            callbackURLs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              description = ''
                Redirect URIs the IdP will hand a code to. Forward-auth
                clients use `https://<host>/oidc/callback` (the traefik
                plugin's callback path); native-OIDC apps use whatever
                their framework mounts — Auth.js is
                `https://<host>/api/auth/callback/<providerId>`.
              '';
            };
            logoutCallbackURLs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Post-logout redirect URIs. Defaults to none.";
            };
            allowedGroups = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ "admins" ];
              description = ''
                Pocket ID group NAMES (`admins`, `family`) allowed to
                use this client — coarse authorization enforced at the
                IdP, before any app sees a request. Admin-only by
                default so a forgotten line fails closed; household
                apps add "family". `[ ]` is the explicit opt-out: any
                account with a passkey gets in.
              '';
              example = [
                "admins"
                "family"
              ];
            };
            skipConsent = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Skip the consent screen — own infrastructure, one operator.";
            };
            pkce = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Require PKCE. Off only for a client that can't do it.";
            };
            traefikForwardAuth = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                This client belongs to traefik's generated `oidc-<name>`
                forward-auth middleware: emit its creds into
                `fleet.sso.clientEnvFile` as
                POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET}.
              '';
            };
            consumers = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = ''
                Container names that speak OIDC themselves with this
                client. Each gets `/run/sso-clients/<name>-env` appended
                to its environmentFiles and is ordered after the render.
              '';
              example = [ "app-anansi" ];
            };
            consumerEnv = {
              id = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = ''
                  Variable name the client ID is written under in the
                  consumer's env file. null omits it — for apps that
                  already take the (non-secret) ID as a plain nix
                  string in their `environment`.
                '';
                example = "GF_AUTH_GENERIC_OAUTH_CLIENT_ID";
              };
              secret = lib.mkOption {
                type = lib.types.str;
                default = "OIDC_CLIENT_SECRET";
                description = ''
                  Variable name the client secret is written under.
                  Whatever the image reads — there is no convention
                  across upstreams.
                '';
                example = "GF_AUTH_GENERIC_OAUTH_CLIENT_SECRET";
              };
            };
            envFile = lib.mkOption {
              type = lib.types.str;
              readOnly = true;
              default = "${renderDir}/${name}-env";
              description = ''
                Read-only: path of the rendered creds file. It is
                appended to every `consumers` container automatically —
                reference this only when something OTHER than a
                container reads the creds (a config render, say), and
                order that unit after `sso-${name}-env-render.service`.
              '';
            };
            logo = lib.mkOption {
              type = lib.types.nullOr lib.types.path;
              default =
                let
                  candidates = map (ext: ./assets/logos + "/${name}.${ext}") [
                    "png"
                    "svg"
                  ];
                  found = lib.filter builtins.pathExists candidates;
                in
                if found == [ ] then null else lib.head found;
              defaultText = lib.literalExpression "./assets/logos/<name>.{png,svg}, when present";
              description = ''
                Image shown on the consent screen and the My Apps page,
                uploaded by the sync when the client has none. Defaults
                to `assets/logos/<name>.png` (or `.svg`) if that file
                exists, so adding a logo is dropping in a file.
              '';
            };
          };
        }
      )
    );
  };

  options.fleet.sso.clientEnvFile = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    readOnly = true;
    default = if forwardAuthClients == { } then null else traefikEnvFile;
    defaultText = lib.literalExpression ''"/run/sso-clients/traefik-env"'';
    description = ''
      Rendered env file carrying POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET}
      for every `traefikForwardAuth` client — consumed by
      stacks/traefik. null when no such client is declared (traefik
      must not be handed a path that was never rendered).
    '';
  };

  config = lib.mkMerge [
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
        callbackURLs = [ "https://${w.hostname}/oidc/callback" ];
        logoutCallbackURLs = [ "https://${w.hostname}/oidc/callback" ];
        allowedGroups = w.authGroups;
        traefikForwardAuth = true;
      }) (lib.filterAttrs (_: w: w.auth == "oidc") config.fleet.webApps);
    }

    {
      # One dotenv file, one key per client. Ciphertext, tracked in git.
      sops.secrets."sso-client-secrets" = mkDotenvSecret ./clients.sops;

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
        after = [ "podman-pocket-id.service" ];
        wants = [ "podman-pocket-id.service" ];
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
          User = "santiago";
          Environment = "XDG_RUNTIME_DIR=/run/user/1000";
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
          prep = extractSecret n;
          content = lib.concatStringsSep "\n" (
            lib.optional (c.consumerEnv.id != null) "${c.consumerEnv.id}=${n}"
            ++ [ "${c.consumerEnv.secret}=\$SECRET_${envName n}" ]
          );
        })
      ) (lib.filterAttrs (_: c: c.consumers != [ ]) cfg);
    }

    # Every declared client must already have its secret in clients.sops,
    # checked HERE, at eval time.
    #
    # This is possible because sops encrypts dotenv VALUES and leaves the
    # KEYS in plaintext, so the file can be read for key presence without
    # any decryption — and it is worth doing because of how badly the
    # alternative fails. The render below is one oneshot for all clients:
    # `extractSecret` exits 1 on the first key it cannot find, so a single
    # missing secret fails the whole unit and leaves EVERY client's creds
    # file — including traefik's forward-auth env — unwritten or stale.
    # One app declared carelessly would take the gate off, or the login
    # path out from under, all of them.
    #
    # That failure lands at activation, where `nixos-rebuild build` cannot
    # see it and daedalus's apply agent has already committed. Asserting at
    # eval turns it into a build error: the Apply fails, the switch never
    # runs, and the fleet's SSO keeps working. It is also what makes
    # `auth.mode` safe to expose as a control in daedalus rather than
    # something only editable by hand here.
    {
      assertions = map (n: {
        assertion = builtins.match ".*(^|\n)${secretKey n}=.*" (builtins.readFile ./clients.sops) != null;
        message = ''
          fleet.ssoClients.${n} has no ${secretKey n} in stacks/pocket-id/clients.sops.

          Add it before declaring the client:
            sops stacks/pocket-id/clients.sops     # ${secretKey n}=<random hex>
            git -C /etc/nixos add stacks/pocket-id/clients.sops

          Without it the sso-clients render exits 1 at activation, which is
          one unit for every client — so this would break the login path for
          all of them, not just ${n}.
        '';
      }) (lib.attrNames cfg);
    }

    # The env file lands on the consumer container from HERE rather than
    # from the consumer's own module: stacks/apps would have to read
    # `config.fleet.ssoClients.<name>` back while defining it, which
    # forces its fragment assembly mid-evaluation (infinite recursion —
    # see the assembly note at the bottom of stacks/apps/apps.nix).
    {
      virtualisation.oci-containers.containers = lib.mkMerge (
        lib.concatMap (
          n: map (unit: { ${unit}.environmentFiles = [ (clientEnvFile n) ]; }) cfg.${n}.consumers
        ) (lib.attrNames cfg)
      );
    }
  ];
}
