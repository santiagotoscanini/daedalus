# n8n — workflow automation + postgres on n8n-net. The n8n container
# also joins traefik-net so traefik dials it as `http://n8n:5678` —
# no host port published.
#
# docker.io path NOT `docker.n8n.io` — the latter is blocked by
# pi-hole (resolves to us, returns traefik's default cert).

{
  config,
  pkgs,
  mkDotenvSecret,
  mkRootlessContainer,
  mkSecretRender,
  ...
}:

let
  # cweagans/n8n-oidc — OIDC login for n8n community edition via the
  # external-hooks system (a single self-contained hooks.js, no npm
  # install). Pinned by commit; it hardcodes two n8n-internal require()
  # paths (@n8n/di, jwt.service.js) verified present in the 2.29.10 image
  # — re-verify on every n8n image bump (upstream is thin, last commit
  # 2025-12-29). Escape hatch if the hook ever breaks: /signin?showLogin=true.
  # cweagans/n8n-oidc — OIDC login for n8n community edition, stock. The
  # homepage tile + Pocket ID launch URL deep-link straight to
  # /auth/oidc/login, so no button-page patch is needed; a direct visit
  # to n8n just shows the hook's one-click "Sign in with SSO" button.
  n8nOidcHook = pkgs.fetchFromGitHub {
    owner = "cweagans";
    repo = "n8n-oidc";
    rev = "f2961d6c6ac103989f4920523b6d3faad7547bc2";
    hash = "sha256-35+prcUzRhtPdVc9sRduwKKNpce5mQfl7WiR7bK1s+A=";
  };
in
{
  # DB password (as both POSTGRES_PASSWORD and DB_POSTGRESDB_PASSWORD —
  # one value, the two names the two images expect) + N8N_BASIC_AUTH_* +
  # encryption key: sops-encrypted env.sops, decrypted to
  # /run/secrets/n8n-env at activation. Edit with `sops env.sops`.
  sops.secrets."n8n-env" = mkDotenvSecret ./env.sops;

  myStack.containerNetworks = {
    n8n-postgres = "n8n";
    n8n = "n8n";
  };

  myStack.webApps.n8n = {
    serviceName = "n8n";
    port = 5678;
    homepage = {
      group = "Productivity";
      name = "n8n";
      # Deep-link the tile straight into the OIDC flow (silent with a live
      # Pocket ID session) — skips the hook's "Sign in with SSO" button.
      href = "https://n8n.toscanini.me/auth/oidc/login";
      description = "Workflow automation";
      icon = "n8n.png";
      widget = {
        type = "customapi";
        # /api/v1/executions?limit=10 → {data: [{id, workflowId, status, startedAt, ...}], nextCursor}
        # Dynamic-list rendering: left column is the raw status
        # (success / error / running), right column is a human name
        # for the workflow. n8n's API does not return the workflow
        # name on the execution row, and customapi cannot join two
        # endpoints — so we hardcode a workflowId → name remap.
        # `name`/`label` are reversed from the natural reading order
        # because formatValue (and therefore `remap`) only runs on the
        # label field, not the name. Add new workflows here as they
        # appear; the `any` rule is a catch-all so unknown hashes
        # never leak into the UI.
        url = "http://n8n:5678/api/v1/executions?limit=10";
        refreshInterval = 60000;
        headers = {
          "X-N8N-API-KEY" = "{{HOMEPAGE_VAR_N8N_API_KEY}}";
        };
        display = "dynamic-list";
        mappings = {
          items = "data";
          limit = 5;
          name = "status";
          label = "workflowId";
          remap = [
            {
              value = "AaEwerVyMkmEEYJH";
              to = "Crypto monitor";
            }
            {
              value = "PE_s7WPIw-c6U3D7JuoQ7";
              to = "Supabase wakeup command";
            }
            {
              value = "71zc3JjYq5cKBfU3Sv5MI";
              to = "Instagram followers";
            }
            {
              value = "G2cUo1VdVDf7vi3t";
              to = "RSS Feeds";
            }
            {
              any = true;
              to = "Unknown workflow";
            }
          ];
        };
      };
    };
  };

  # n8n runs as a mapped uid that can't read the santiago-owned mail secret
  # directly, so render N8N_SMTP_PASS into an --env-file podman injects as
  # santiago (same activation-render idiom as litellm-prom-token). Single
  # source of truth stays the shared platform/mail secret.
  systemd.services."n8n-smtp-env" = mkSecretRender {
    description = "Render N8N_SMTP_PASS from the shared mail relay secret";
    gates = [ "podman-n8n.service" ];
    dir = "/run/n8n-smtp";
    file = "/run/n8n-smtp/env";
    content = "N8N_SMTP_PASS=$(cat ${config.sops.secrets."mail-relay-password".path})";
  };

  # Wait for the rendered env file (merges with common.nix's generated override).
  systemd.services.podman-n8n = {
    after = [ "n8n-smtp-env.service" ];
    wants = [ "n8n-smtp-env.service" ];
  };

  virtualisation.oci-containers.containers.n8n-postgres = mkRootlessContainer {
    image = "docker.io/library/postgres:15-alpine@sha256:3d0f7584ed7d04e27fa050d6683a74746608faf21f202be78460d679cc56461f";

    volumes = [
      "/home/santiago/selfhost/n8n/db:/var/lib/postgresql/data"
    ];

    environment = {
      POSTGRES_DB = "n8n";
      POSTGRES_USER = "n8n";
    };

    # POSTGRES_PASSWORD (native key name — no entrypoint aliasing).
    environmentFiles = [ config.sops.secrets."n8n-env".path ];

    extraOptions = [
      "--network=n8n-net"
    ];
  };

  virtualisation.oci-containers.containers.n8n = mkRootlessContainer {
    image = "docker.io/n8nio/n8n:2.30.7@sha256:23a26975c21aa6f7113286668b35e2831ec898d3a7fbfa1ac8ff16f1bdf88c37";
    dependsOn = [ "n8n-postgres" ];

    volumes = [
      "/home/santiago/selfhost/n8n/data:/home/node/.n8n"
      "/home/santiago/selfhost/n8n/local-files:/files"
      "${n8nOidcHook}/hooks.js:/opt/oidc-hooks.js:ro"
    ];

    environment = {
      DB_TYPE = "postgresdb";
      DB_POSTGRESDB_HOST = "n8n-postgres";
      DB_POSTGRESDB_PORT = "5432";
      DB_POSTGRESDB_DATABASE = "n8n";
      DB_POSTGRESDB_USER = "n8n";
      N8N_BASIC_AUTH_ACTIVE = "true";
      N8N_HOST = "n8n.toscanini.me";
      N8N_PORT = "5678";
      N8N_PROTOCOL = "https";
      NODE_ENV = "production";
      WEBHOOK_URL = "https://n8n.toscanini.me";
      GENERIC_TIMEZONE = config.time.timeZone;

      # Instance SMTP (user-management emails) via the same Gmail relay.
      # N8N_SMTP_PASS is injected from the rendered env file (below): n8n
      # runs as a mapped uid that can't read the santiago-owned mail secret,
      # so podman injects it as an --env-file instead.
      N8N_EMAIL_MODE = "smtp";
      N8N_SMTP_HOST = config.myStack.mail.smtpHost;
      N8N_SMTP_PORT = toString config.myStack.mail.smtpPort;
      N8N_SMTP_USER = config.myStack.mail.sender;
      N8N_SMTP_SENDER = config.myStack.mail.sender;
      N8N_SMTP_SSL = "false";
      N8N_SMTP_STARTTLS = "true";

      # Pocket ID SSO via the external hook (AUTH.md). The hook adds a
      # "Sign in with SSO" button + /auth/oidc/{login,callback}; password
      # login stays as the fallback (/signin?showLogin=true). Webhooks and
      # /rest/oauth2-credential/callback are untouched. OIDC_CLIENT_ID +
      # OIDC_CLIENT_SECRET ride env.sops; the hook derives its state/nonce
      # HMAC key from N8N_ENCRYPTION_KEY (also in env.sops).
      EXTERNAL_HOOK_FILES = "/opt/oidc-hooks.js";
      # Keep /auth/* off the SPA history-API catchall so the two backend
      # routes aren't swallowed by index.html.
      N8N_ADDITIONAL_NON_UI_ROUTES = "auth";
      # Frontend patch (served by the hook itself at this /assets path).
      EXTERNAL_FRONTEND_HOOKS_URLS = "/assets/oidc-frontend-hook.js";
      OIDC_ISSUER_URL = "https://id.toscanini.me";
      OIDC_REDIRECT_URI = "https://n8n.toscanini.me/auth/oidc/callback";
      OIDC_SCOPES = "openid email profile";
    };

    # DB_POSTGRESDB_PASSWORD + N8N_BASIC_AUTH_* + N8N_ENCRYPTION_KEY
    # (native key names), plus the rendered N8N_SMTP_PASS (from the
    # shared mail secret via n8n-smtp-env.service).
    environmentFiles = [
      config.sops.secrets."n8n-env".path
      "/run/n8n-smtp/env"
    ];

    extraOptions = [
      "--network=n8n-net"
      # Also join traefik-net so the file-provider rule can dial
      # `http://n8n:5678` by container DNS — no host port needed.
      "--network=traefik-net"
    ];
  };
}
