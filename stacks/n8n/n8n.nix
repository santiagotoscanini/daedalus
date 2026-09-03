# n8n — workflow automation. Its database lives on the shared app-db
# cluster (stacks/app-db); the container joins app-db-net to dial `pg`
# and traefik-net so traefik dials it as `http://n8n:5678` — no host
# port published.
#
# docker.io path NOT `docker.n8n.io` — the latter is blocked by
# pi-hole (resolves to us, returns traefik's default cert).
#
# ── this instance separates a DRAFT from a PUBLISHED version ───────────
#
# Editing a workflow through the API (or the MCP server) writes the
# DRAFT. Scheduled triggers and production runs execute the PUBLISHED
# version, so an edit changes nothing about what actually runs until it
# is published. Reading the workflow back only proves the draft holds
# the edit — it is NOT evidence the change is live.
#
#   get_workflow_details → .workflow.versionId vs .workflow.activeVersionId
#   equal = published; different = there is an unpublished draft
#
# This cost a full session once: fixes were reported live while sitting
# unpublished, and two "backfill" runs silently executed the OLD
# published version, which then looked like a de-duplication bug that
# did not exist.
#
# Consequence for temporary states (widened date windows, disabled
# de-dupe, purge nodes): they must be PUBLISHED to run, so for a while
# the destructive-ish config IS the scheduled config. Design them to be
# harmless if left published — prefer disabling a de-dupe node (worst
# case: duplicates) over deleting rows (worst case: data loss) — and
# revert + republish immediately after.
#
# n8n also issues TWO unrelated JWTs, told apart by their `aud` claim:
# `public-api` (in stacks/daedalus/service-keys.sops, reaches /api/v1/*)
# and `mcp-server-api` (in .claude/mcp.json.sops, reaches
# /mcp-server/http). Rotating one does not touch the other, and neither
# works in the other's place. Public-api keys are per-resource scoped, so
# "n8n returns 403" is never one fact — it is per endpoint.

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
  # install), used stock. Pinned by commit; it hardcodes two n8n-internal
  # require() paths (@n8n/di, jwt.service.js) verified present in the
  # 2.33.2 image — re-verify on every n8n image bump (upstream is thin,
  # last commit 2025-12-29). The Pocket ID launch URL deep-links straight
  # to /auth/oidc/login, so no button-page patch is needed; a direct visit to n8n just shows the hook's one-click
  # "Sign in with SSO" button. Escape hatch if the hook ever breaks:
  # /signin?showLogin=true.
  n8nOidcHook = pkgs.fetchFromGitHub {
    owner = "cweagans";
    repo = "n8n-oidc";
    rev = "f2961d6c6ac103989f4920523b6d3faad7547bc2";
    hash = "sha256-35+prcUzRhtPdVc9sRduwKKNpce5mQfl7WiR7bK1s+A=";
  };
in
{
  # Encryption key + OIDC client creds:
  # sops-encrypted env.sops, decrypted to /run/secrets/n8n-env at
  # activation. Edit with `sops env.sops`. The DB password comes from
  # the app-db-generated env file, not from here.
  sops.secrets."n8n-env" = mkDotenvSecret ./env.sops;

  fleet.bridgeMemberships.n8n = [
    "app-db"
    "traefik"
  ];

  fleet.statePaths = {
    "${config.fleet.stateRoot}/n8n/data".uid = 1000;
    "${config.fleet.stateRoot}/n8n/local-files".uid = 1000;
  };

  # Database on the shared app-db cluster: role + db + env file with
  # DATABASE_URL (and the password under both POSTGRES_PASSWORD and
  # DB_POSTGRESDB_PASSWORD — the name this image reads), materialized
  # by app-db-n8n-bootstrap.service (see stacks/app-db/).
  fleet.appDatabases.n8n.consumers = [ "n8n" ];

  # Pocket ID client — id `n8n`, secret generated on the box,
  # rendered into the container as the
  # OIDC_CLIENT_* pair the hook reads. PKCE stays off: the hook's
  # authorization request carries no code_challenge.
  fleet.ssoClients.n8n = {
    displayName = "n8n";
    description = "Workflow automation";
    launchURL = "https://n8n.toscanini.me/auth/oidc/login";
    callbackURLs = [ "https://n8n.toscanini.me/auth/oidc/callback" ];
    logoutCallbackURLs = [ "https://n8n.toscanini.me/auth/oidc/callback" ];
    pkce = false;
    consumers = [ "n8n" ];
    consumerEnv = {
      id = "OIDC_CLIENT_ID";
      secret = "OIDC_CLIENT_SECRET";
    };
  };

  fleet.webApps.n8n = {
    serviceName = "n8n";
    port = 5678;
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

  # Wait for the rendered SMTP env file (the app-db ordering comes
  # from appDatabases.consumers). Merges with podman.nix's override.
  systemd.services.podman-n8n = {
    after = [ "n8n-smtp-env.service" ];
    wants = [ "n8n-smtp-env.service" ];
  };

  virtualisation.oci-containers.containers.n8n = mkRootlessContainer {
    image = "docker.io/n8nio/n8n:2.38.2@sha256:0c85741381be21cfaf9eafd75fa4c5e5df499cf5e205e5098681701767ff7416";

    volumes = [
      "${config.fleet.stateRoot}/n8n/data:/home/node/.n8n"
      "${config.fleet.stateRoot}/n8n/local-files:/files"
      "${n8nOidcHook}/hooks.js:/opt/oidc-hooks.js:ro"
    ];

    environment = {
      DB_TYPE = "postgresdb";
      DB_POSTGRESDB_HOST = "pg";
      DB_POSTGRESDB_PORT = "5432";
      DB_POSTGRESDB_DATABASE = "n8n";
      DB_POSTGRESDB_USER = "n8n";
      N8N_HOST = "n8n.toscanini.me";
      N8N_PORT = "5678";
      N8N_PROTOCOL = "https";
      NODE_ENV = "production";
      N8N_WEBHOOK_URL = "https://n8n.toscanini.me";
      # The TickTick community node is unverified; the default flips to
      # false in a future release, which would drop it from the instance.
      N8N_UNVERIFIED_PACKAGES_ENABLED = "true";
      # Renames .n8n/binaryData to .n8n/storage. The bind mount is the
      # parent .n8n dir, so the rename stays inside it.
      N8N_MIGRATE_FS_STORAGE_PATH = "true";
      # Exactly one reverse proxy (traefik) sits in front, so trust one
      # X-Forwarded-* hop. Without this n8n leaves Express `trust proxy`
      # off and logs a ValidationError on every X-Forwarded-For request.
      N8N_PROXY_HOPS = "1";
      GENERIC_TIMEZONE = config.time.timeZone;

      # n8n warns at every start that these three defaults shrink in a
      # future release. Pinning them to today's values makes the limits
      # explicit, so an image bump can't silently start timing out long
      # tasks or rejecting large archives.
      N8N_RUNNERS_TASK_TIMEOUT = "300";
      N8N_COMPRESSION_NODE_MAX_DECOMPRESSED_SIZE_BYTES = "2147483648";
      N8N_COMPRESSION_NODE_MAX_ZIP_ENTRIES = "5000";

      # The image ships no Python 3, so the Python task runner fails at
      # every start. Code nodes use JavaScript here; turn it off rather
      # than retry something that cannot succeed.
      N8N_PYTHON_ENABLED = "false";

      # Instance SMTP (user-management emails) via the same Gmail relay.
      # N8N_SMTP_PASS is injected from the rendered env file (below): n8n
      # runs as a mapped uid that can't read the santiago-owned mail secret,
      # so podman injects it as an --env-file instead.
      N8N_EMAIL_MODE = "smtp";
      N8N_SMTP_HOST = config.fleet.mail.smtpHost;
      N8N_SMTP_PORT = toString config.fleet.mail.smtpPort;
      N8N_SMTP_USER = config.fleet.mail.sender;
      N8N_SMTP_SENDER = config.fleet.mail.sender;
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
      OIDC_ISSUER_URL = config.fleet.sso.issuerUrl;
      OIDC_REDIRECT_URI = "https://n8n.toscanini.me/auth/oidc/callback";
      OIDC_SCOPES = "openid email profile";
    };

    # N8N_ENCRYPTION_KEY + OIDC creds from sops, the rendered
    # N8N_SMTP_PASS (from the shared mail secret via n8n-smtp-env),
    # and DB_POSTGRESDB_PASSWORD from the app-db bootstrap env.
    # Later files win.
    environmentFiles = [
      config.sops.secrets."n8n-env".path
      "/run/n8n-smtp/env"
      config.fleet.appDatabases.n8n.envFile
    ];

  };
}
