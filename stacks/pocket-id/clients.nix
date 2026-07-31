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
#     `/run/sso-clients/<name>-env` appended to its environmentFiles
#     (carrying OIDC_CLIENT_SECRET) by this module — consumers never
#     read the path back out of `config`, which would recurse through
#     stacks/apps' fragment assembly.
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
        body = {
          name = c.displayName;
          inherit (c) description;
          callbackURLs = c.callbackURLs;
          logoutCallbackURLs = c.logoutCallbackURLs;
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
              default = [ ];
              description = ''
                Pocket ID group NAMES (`admins`, `family`) allowed to
                use this client — coarse authorization enforced at the
                IdP, before any app sees a request. `[ ]` leaves the
                client unrestricted (any account with a passkey gets
                in), which is almost never what you want here.
              '';
              example = [ "admins" ];
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
                client. Each gets `/run/sso-clients/<name>-env`
                (OIDC_CLIENT_SECRET) appended to its environmentFiles
                and is ordered after the render.
              '';
              example = [ "app-anansi" ];
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

    # Per-client secret for native-OIDC consumers.
    {
      systemd.services = lib.mapAttrs' (
        n: c:
        lib.nameValuePair "sso-${n}-env-render" (mkSecretRender {
          description = "Render the Pocket ID client secret for ${n}";
          gates = map (unit: "podman-${unit}.service") c.consumers;
          dir = renderDir;
          file = clientEnvFile n;
          prep = extractSecret n;
          content = "OIDC_CLIENT_SECRET=\$SECRET_${envName n}";
        })
      ) (lib.filterAttrs (_: c: c.consumers != [ ]) cfg);
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
