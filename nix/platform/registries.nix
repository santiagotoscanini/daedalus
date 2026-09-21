{ config, lib, ... }:

# Registries an engine module WRITES and a stack outside this tree still
# IMPLEMENTS.
#
# A stack migrates here one at a time, and the first thing each one does is
# contribute to a registry — an OIDC client for its login, a log label, a
# database. While the registry's owner is still a stack in a host's own
# configuration, its `options` declaration has to live where every writer can
# see it, which is here: ungated, no switch, exactly as it was declared in its
# owner. The owner keeps the `config` half (the units that converge what the
# registry describes) and migrates later with nothing left to untangle.
#
# With the owner absent, an entry is a declaration nothing acts on: a host
# that enables a module writing `fleet.ssoClients.<n>` but runs no identity
# provider stack evaluates, and gets no client.
#
# When an owner migrates into this tree its declaration moves back beside its
# implementation and leaves this file. The file is meant to shrink to nothing.
{
  options.fleet.sso = {
    renderDir = lib.mkOption {
      type = lib.types.str;
      default = "/run/sso-clients";
      readOnly = true;
      description = ''
        Where the identity-provider stack renders each client's credentials
        (`<renderDir>/<client>-env`). Declared with the registry because
        `fleet.ssoClients.<n>.envFile` is derived from it.
      '';
    };

    logoDir = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        A directory of `<client>.png` / `<client>.svg` logos, looked up by
        `fleet.ssoClients.<n>.logo`'s default. Host data: logos for the
        clients of stacks the host keeps itself. An engine module carries
        its own logo and sets `logo` directly.
      '';
    };
  };

  options.fleet.ssoClients = lib.mkOption {
    default = { };
    description = ''
      OIDC clients at the identity provider, converged by the stack that runs it.
      The attr name IS the OIDC client_id; the secret is generated on
      first declaration by `sso-client-secrets.service` and needs no
      operator step.
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
                IdP group NAMES allowed to
                use this client — coarse authorization enforced at the
                IdP, before any app sees a request. Admin-only by
                default so a forgotten line fails closed; a household
                app adds the household's group. `[ ]` is the explicit opt-out: any
                account with a passkey gets in.
              '';
              example = [
                "admins"
                "household"
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
              example = [ "app-example" ];
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
              default = "${config.fleet.sso.renderDir}/${name}-env";
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
                  dir = config.fleet.sso.logoDir;
                  candidates = map (ext: dir + "/${name}.${ext}") [
                    "png"
                    "svg"
                  ];
                  found = lib.filter builtins.pathExists candidates;
                in
                if dir == null || found == [ ] then null else lib.head found;
              defaultText = lib.literalExpression "<fleet.sso.logoDir>/<name>.{png,svg}, when present";
              description = ''
                Image shown on the consent screen and the My Apps page,
                uploaded by the sync when the client has none. A module that
                ships its own sets it (`logo = ./assets/<name>.png`);
                otherwise it defaults to `<name>.png` (or `.svg`) in
                `fleet.sso.logoDir` when the host has one.
              '';
            };
          };
        }
      )
    );
  };
}
