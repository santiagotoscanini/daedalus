# wealthfolio — personal finance tracker. Single container, split-
# horizon publish. Joins traefik-net so traefik dials
# `http://wealthfolio:8088` — no host port published.
#
# To rotate the admin password, regenerate the argon2 hash:
#   echo -n "<new-pass>" | argon2 "<salt>" -id -m 12 -t 3 -p 1 -e
# The output is WF_AUTH_PASSWORD_HASH, verbatim (single `$`, no
# escaping). Then
# `systemctl restart podman-wealthfolio`.

{
  config,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:

{
  myStack.containerNetworks.wealthfolio = "traefik";
  myStack.webApps.wealthfolio = {
    serviceName = "wealthfolio";
    port = 8088;
    exposeRemotely = true;
    homepage = {
      group = "Productivity";
      # Deep-link the SSO start — skips the login page's button click
      # (silent round-trip through Pocket ID when a session is alive).
      href = "https://wealthfolio.toscanini.me/api/v1/auth/oidc/login";
      description = "Personal finance";
      icon = "/icons/wealthfolio.png";
    };
  };

  # WF_* secrets: sops-encrypted env.sops -> /run/secrets/wealthfolio-env
  # (tmpfs, 0400 santiago). Edit with `sops env.sops`.
  sops.secrets."wealthfolio-env" = mkDotenvSecret ./env.sops;

  virtualisation.oci-containers.containers.wealthfolio = mkRootlessContainer {
    image = "docker.io/afadil/wealthfolio:3.6.2@sha256:f24c607692c1b494a477382aa3dfedc11ede1b433768b66546940c8f6b8a474f";

    volumes = [
      "/home/santiago/selfhost/wealthfolio/data:/data"
    ];

    # Pocket ID SSO (AUTH.md) — public client, PKCE, no secret, so
    # plain env suffices. OIDC-only: WF_AUTH_PASSWORD_HASH was removed
    # from env.sops (git history has it, or regenerate per the header
    # comment) — the login page offers just "Sign in with SSO".
    environment = {
      WF_OIDC_ISSUER_URL = "https://id.toscanini.me";
      WF_OIDC_CLIENT_ID = "36e5f60b-173f-4686-8b2b-830ff5d98fd8";
      WF_OIDC_REDIRECT_URL = "https://wealthfolio.toscanini.me/api/v1/auth/oidc/callback";
      # santito's Pocket ID sub — the only allowed account.
      WF_OIDC_ALLOWED_SUBS = "1ae66034-d627-46f7-9c04-1d8c05639a1a";
    };

    # WF_LISTEN_ADDR + WF_DB_PATH + WF_SECRET_KEY + WF_AUTH_PASSWORD_HASH
    # + WF_CORS_ALLOW_ORIGINS.
    environmentFiles = [ config.sops.secrets."wealthfolio-env".path ];

    extraOptions = [
      "--network=traefik-net"
    ];
  };
}
