{ config, lib, ... }:

# platform/identity.nix — the fleet's single-sign-on interface.
#
# One identity provider issues every login on a box, and nearly everything
# else is a client of it: the reverse proxy's forward-auth middlewares, the
# apps that speak OIDC themselves, the probes that fetch its discovery
# document at start. What they all share is declared HERE, in the platform,
# and implemented by whichever stack runs the provider (the catalog's
# pocket-id) — the same split as publishing.nix, where `webApps` is the
# interface and the proxy, the resolver and the tunnel are its readers.
#
#   sso.issuerUrl            where the provider is, for every client's config
#   sso.discoveryConsumers   containers the provider's stack must gate at boot
#   ssoClients.<id>          the clients to converge, one per login
#   sso.clientEnvFile        where the proxy finds its clients' credentials
#   sso.renderDir            where each client's credentials are rendered
#   sso.logoDir              a host's logos for the clients of its own stacks
#
# With the provider's stack switched off, every entry is a declaration
# nothing acts on: a host that enables a module writing `fleet.ssoClients.<n>`
# but runs no identity provider evaluates, and gets no client — and
# `issuerUrl` is "" so a consumer that is on while the provider is off is
# MISCONFIGURED (its endpoints point at ""), not an eval error. Turning the
# provider off is a change to the box's identity model that each gated app
# has to answer for itself.
{
  options.fleet.sso = {
    issuerUrl = lib.mkOption {
      type = lib.types.str;
      default =
        if config.fleet.webApps ? pocket-id then
          "https://${config.fleet.webApps.pocket-id.hostname}"
        else
          "";
      defaultText = lib.literalExpression ''"https://''${fleet.webApps.pocket-id.hostname}"'';
      description = "OIDC issuer URL of the box-wide identity provider; \"\" while none is switched on.";
    };

    discoveryConsumers = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Container names that fetch the OIDC discovery document while
        starting up and cannot recover if it isn't being served yet —
        they either panic or silently come up with OIDC login broken until
        a restart. Under `--rm` a crash leaves the oneshot unit green with
        no container behind it, so the failure is invisible.

        The identity provider's stack orders each listed container behind
        the proxy and itself, and blocks it on a bounded probe of the real
        discovery URL. Ordering alone is not enough: it only proves
        `podman run -d` returned, and the request path that actually matters
        runs through the proxy.

        Registration is opt-in — an app that fetches discovery lazily or
        re-tries on its own doesn't need it.
      '';
      example = lib.literalExpression ''[ "gatus" "zot" ]'';
    };

    clientEnvFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      readOnly = true;
      default =
        if lib.filterAttrs (_: c: c.traefikForwardAuth) config.fleet.ssoClients == { } then
          null
        else
          "${config.fleet.sso.renderDir}/traefik-env";
      defaultText = lib.literalExpression ''"''${fleet.sso.renderDir}/traefik-env"'';
      description = ''
        Rendered env file carrying POCKET_OIDC_<NAME>_CLIENT_{ID,SECRET}
        for every `traefikForwardAuth` client — consumed by the reverse
        proxy. null when no such client is declared (the proxy must not be
        handed a path that was never rendered).
      '';
    };

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
