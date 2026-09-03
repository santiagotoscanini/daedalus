# wealthfolio — personal finance tracker. Single container, split-
# horizon publish. Joins traefik-net so traefik dials
# `http://wealthfolio:8088` — no host port published.
#
# To enable password login alongside SSO, generate an argon2 hash:
#   echo -n "<pass>" | argon2 "<salt>" -id -m 12 -t 3 -p 1 -e
# and add it to env.sops as WF_AUTH_PASSWORD_HASH, verbatim (single
# `$`, no escaping). Then `systemctl restart podman-wealthfolio`.
#
# ── MCP (Settings › AI Agent Access) ───────────────────────────────────
#
# WF_MCP_ENABLED serves a streamable-HTTP MCP endpoint at /mcp on the
# same port, authenticated by a Bearer token minted in the app's own UI
# (Settings › AI Agent Access › Create token — shown once; pick the
# scopes there, read-only is the default preset). It rides the LiteLLM
# gateway like every other MCP server (fleet.mcpServers.Wealthfolio):
# litellm dials http://wealthfolio:8088/mcp over traefik-net and injects
# the token, so a gateway client presents its LiteLLM key and never
# holds this one. The token lives in stacks/litellm/env.sops as
# WEALTHFOLIO_MCP_TOKEN — litellm is the only thing that presents it,
# which is the same reason TICKTICK_MCP_TOKEN lives there. Rotate:
# create a new token in the UI, `sops stacks/litellm/env.sops`, rebuild,
# `systemctl restart podman-litellm`.
#
# The token carries the read + write + suggest preset ON PURPOSE
# (operator decision, 2026-09-03): models may record and commit
# activities, not just read. Wealthfolio's draft-then-commit tool pairs
# are the guard rail. Don't re-propose a read-only token.

{
  config,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

{
  fleet.bridgeMemberships.wealthfolio = [ "traefik" ];

  # OIDC discovery runs at startup and is fatal on failure; under --rm
  # the crash leaves the oneshot unit green with no container behind it.
  fleet.sso.discoveryConsumers = [ "wealthfolio" ];

  # Pocket ID client — id `wealthfolio`, declarative like every other.
  #
  # It IS a consumer of its own secret, and the reason is worth stating: the
  # converge registers every client with `isPublic = false`, so Pocket ID
  # demands client authentication at the token endpoint. This entry used to
  # claim wealthfolio "authenticates with PKCE and never sends a client
  # secret" — true of the hand-made client that predated the declarative
  # sync, and false the moment the sync overwrote it. The result was a login
  # that redirected, came back with a code, and died at the exchange with
  # `invalid_client` for thirteen days, because nobody signed in during them.
  #
  # PKCE stays on. It is not an alternative to the secret here, it is the
  # other half — the secret proves which client is asking, PKCE proves it is
  # the same party that started the flow.
  fleet.ssoClients.wealthfolio = {
    description = "Personal finance";
    launchURL = "https://wealthfolio.toscanini.me/api/v1/auth/oidc/login";
    callbackURLs = [ "https://wealthfolio.toscanini.me/api/v1/auth/oidc/callback" ];
    logoutCallbackURLs = [ "https://wealthfolio.toscanini.me/api/v1/auth/oidc/callback" ];
    consumers = [ "wealthfolio" ];
    consumerEnv.secret = "WF_OIDC_CLIENT_SECRET";
  };

  # Registration on the LiteLLM MCP gateway lives with the app that serves
  # it (see stacks/litellm/mcp.nix). `exposeRemotely` publishes
  # /Wealthfolio/mcp through the CF tunnel for off-box MCP clients — the
  # app's own hostname already is, and the path is double-gated (LiteLLM
  # virtual key, then this app's scoped token).
  fleet.mcpServers.Wealthfolio = {
    url = "http://wealthfolio:8088/mcp";
    authType = "bearer_token";
    authValue = "os.environ/WEALTHFOLIO_MCP_TOKEN";
    description = "Wealthfolio portfolio: accounts, holdings, performance, activities, planning";
    logoUrl = "https://wealthfolio.app/favicon.png";
    exposeRemotely = true;
  };

  fleet.statePaths."${config.fleet.stateRoot}/wealthfolio/data".uid = 1000;
  fleet.webApps.wealthfolio = {
    serviceName = "wealthfolio";
    port = 8088;
    exposeRemotely = true;
  };

  # WF_* secrets: sops-encrypted env.sops -> /run/secrets/wealthfolio-env
  # (tmpfs, 0400 santiago). Edit with `sops env.sops`.
  sops.secrets."wealthfolio-env" = mkDotenvSecret ./env.sops;

  virtualisation.oci-containers.containers.wealthfolio = mkRootlessContainer {
    image = "docker.io/afadil/wealthfolio:3.7.0@sha256:de137d64acf712c5c71093b27ecc98ccc1dbbbf00befdb684bed531cdb40069a";

    volumes = [
      "${config.fleet.stateRoot}/wealthfolio/data:/data"
    ];

    # Pocket ID SSO (AUTH.md) — confidential client with PKCE. Only the
    # non-secret half is here; WF_OIDC_CLIENT_SECRET arrives in the rendered
    # creds file the `consumers` entry above appends. OIDC-only: env.sops
    # carries no WF_AUTH_PASSWORD_HASH (the header runbook mints one if
    # password login is ever wanted) — the login page offers just "Sign in
    # with SSO".
    environment = {
      WF_LISTEN_ADDR = "0.0.0.0:8088";
      WF_DB_PATH = "/data/wealthfolio.db";
      WF_CORS_ALLOW_ORIGINS = "https://wealthfolio.toscanini.me";
      WF_OIDC_ISSUER_URL = config.fleet.sso.issuerUrl;
      WF_OIDC_CLIENT_ID = "wealthfolio";
      WF_OIDC_REDIRECT_URL = "https://wealthfolio.toscanini.me/api/v1/auth/oidc/callback";
      # santito's Pocket ID sub — the only allowed account.
      WF_OIDC_ALLOWED_SUBS = "1ae66034-d627-46f7-9c04-1d8c05639a1a";
      # /mcp for the LiteLLM gateway — see the header.
      WF_MCP_ENABLED = "true";
    };

    # WF_SECRET_KEY — the only actual secret; non-secret config lives
    # reviewable in `environment` above.
    environmentFiles = [ config.sops.secrets."wealthfolio-env".path ];

    # SQLite at WF_DB_PATH — give it >10s to flush and close cleanly on
    # stop so a reboot SIGKILL can't corrupt the DB mid-write.
    extraOptions = [
      "--stop-timeout=30"
    ];

  };
}
