# wealthfolio — personal finance tracker. Single container, split-
# horizon publish. Joins traefik-net so traefik dials
# `http://wealthfolio:8088` — no host port published.
#
# To enable password login alongside SSO, generate an argon2 hash:
#   echo -n "<pass>" | argon2 "<salt>" -id -m 12 -t 3 -p 1 -e
# and add it to env.sops as WF_AUTH_PASSWORD_HASH, verbatim (single
# `$`, no escaping). Then `systemctl restart podman-wealthfolio`.

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
  # No `consumers`: wealthfolio authenticates with PKCE and never sends
  # a client secret, so nothing here consumes SSO_SECRET_WEALTHFOLIO —
  # the key exists so a rebuilt IdP still gets a complete client.
  fleet.ssoClients.wealthfolio = {
    description = "Personal finance";
    launchURL = "https://wealthfolio.toscanini.me/api/v1/auth/oidc/login";
    callbackURLs = [ "https://wealthfolio.toscanini.me/api/v1/auth/oidc/callback" ];
    logoutCallbackURLs = [ "https://wealthfolio.toscanini.me/api/v1/auth/oidc/callback" ];
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
    image = "docker.io/afadil/wealthfolio:3.6.3@sha256:2c939f64043481d7c5e4fc737ed872518633c838bff9b9de699f0c158df4bc0b";

    volumes = [
      "${config.fleet.stateRoot}/wealthfolio/data:/data"
    ];

    # Pocket ID SSO (AUTH.md) — public client, PKCE, no secret, so
    # plain env suffices. OIDC-only: env.sops carries no
    # WF_AUTH_PASSWORD_HASH (the header runbook mints one if password
    # login is ever wanted) — the login page offers just "Sign in
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
