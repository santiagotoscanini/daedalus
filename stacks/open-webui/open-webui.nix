# open-webui — ChatGPT-style frontend for the local models behind
# LiteLLM. Its database lives on the shared app-db cluster (role/db
# `open-webui`); the container joins:
#   - app-db-net    → dial `pg` for chats/settings
#   - traefik-net   → traefik dials `http://open-webui:8080`, AND
#                     open-webui dials `http://litellm:4000` (LLM + STT)
#   - openwebui-net → private bridge to searxng (web search); mcpo later
#
# Capabilities wired here:
#   - Chat/vision   → LiteLLM `gemma-4-12b` (has vision + tool-calling)
#   - Audio (STT)   → LiteLLM `whisper-1` → subgen (tv stack)
#   - PDF/RAG       → Open WebUI built-in embeddings (local sentence-
#                     transformers) + Chroma, both in the data dir. No
#                     dependency on the manually-run Lemonade box.
#   - Web search    → self-hosted SearXNG (searxng:8080), JSON API
#
# SSO: native OIDC against Pocket ID (client "Open WebUI", created via
# the Pocket ID API; callback https://chat.toscanini.me/oauth/oidc/
# callback). OAUTH_CLIENT_ID/SECRET ride env.sops. Local password login
# stays as break-glass; new accounts are SSO-only, merged by email.
#
# Secrets:
#   - WEBUI_SECRET_KEY / SEARXNG_SECRET → machine-generated on first
#     boot into secrets/ (gitignored). Rotate = delete file + rebuild.
#   - OPENAI_API_KEY (the LiteLLM master key) → rendered from
#     litellm/env.sops via open-webui-litellm-key.service, never
#     duplicated (single source of truth stays litellm's env.sops).

{
  config,
  pkgs,
  mkDotenvSecret,
  mkRootlessContainer,
  mkSecretRender,
  ...
}:

let
  dataDir = "/home/santiago/selfhost/open-webui/data";
  secretsDir = "/home/santiago/selfhost/open-webui/secrets";
  webuiSecretFile = "${secretsDir}/webui-env";
  searxngSecretFile = "${secretsDir}/searxng-env";
  litellmKeyFile = "/run/open-webui-litellm/env";
in
{
  fleet.bridgeMemberships = {
    open-webui = [
      "app-db"
      "traefik"
      "openwebui"
      "monitoring" # push OTLP metrics to alloy:4317 (the box's collector)
    ];
    searxng = [ "openwebui" ];
  };

  # OIDC client id + secret (Pocket ID client "Open WebUI", created via
  # the Pocket ID API). Edit with `sops env.sops`.
  sops.secrets."open-webui-env" = mkDotenvSecret ./env.sops;

  fleet.statePaths."${dataDir}".uid = 0; # container root → santiago:users

  # Loki stack label for both containers (alloy tags journal lines).
  fleet.logStacks.open-webui = [
    "open-webui"
    "searxng"
  ];

  # Postgres role/db `open_webui` (underscore — the bootstrap raw-
  # interpolates the name into ALTER ROLE/GRANT, so no hyphens) + env
  # file with DATABASE_URL, from app-db-open_webui-bootstrap.service.
  fleet.appDatabases.open_webui.consumers = [ "open-webui" ];

  fleet.webApps.open-webui = {
    hostname = "chat.toscanini.me";
    serviceName = "open-webui";
    port = 8080;
    healthPath = "/health"; # gatus probes the real upstream (unauthenticated 200)
    homepage = {
      group = "Cloud & AI";
      name = "Open WebUI";
      href = "https://chat.toscanini.me/";
      description = "Chat with local models (Gemma/Whisper via LiteLLM)";
      icon = "open-webui.png";
    };
  };

  # Machine-generated secrets, born on the box on first boot. Idempotent:
  # each file is created only if missing (delete + rebuild to rotate).
  systemd.services."open-webui-secrets-bootstrap" = {
    description = "Bootstrap open-webui: generate WEBUI_SECRET_KEY + SEARXNG_SECRET on first boot";
    before = [
      "podman-open-webui.service"
      "podman-searxng.service"
    ];
    wantedBy = [
      "podman-open-webui.service"
      "podman-searxng.service"
    ];
    after = [ "local-fs.target" ];
    path = [
      pkgs.openssl
      pkgs.coreutils
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      Restart = "on-failure";
      RestartSec = "5s";
    };
    script = ''
      set -eu
      install -d -m 0700 -o santiago -g users "${secretsDir}"
      if [ ! -e "${webuiSecretFile}" ]; then
        install -m 0600 -o santiago -g users /dev/stdin "${webuiSecretFile}" <<EOF
      WEBUI_SECRET_KEY=$(openssl rand -hex 32)
      EOF
      fi
      if [ ! -e "${searxngSecretFile}" ]; then
        install -m 0600 -o santiago -g users /dev/stdin "${searxngSecretFile}" <<EOF
      SEARXNG_SECRET=$(openssl rand -hex 32)
      EOF
      fi
    '';
  };

  # Render the LiteLLM master key as OPENAI_API_KEY (used for both the
  # LLM calls and the audio-STT calls). One encrypted source of truth
  # stays litellm/env.sops — same idiom as litellm-prom-token / homepage.
  systemd.services."open-webui-litellm-key" = mkSecretRender {
    description = "Render the LiteLLM master key as OPENAI_API_KEY for open-webui";
    gates = [ "podman-open-webui.service" ];
    dir = "/run/open-webui-litellm";
    file = litellmKeyFile;
    prep = "KEY=$(grep '^LITELLM_MASTER_KEY=' ${config.sops.secrets."litellm-env".path} | head -1 | cut -d= -f2-)";
    # One key for every door into the gateway: chat, STT, TTS, embeddings,
    # image-gen all hit litellm:4000 with the same master key.
    content = ''
      OPENAI_API_KEY=$KEY
      AUDIO_STT_OPENAI_API_KEY=$KEY
      AUDIO_TTS_API_KEY=$KEY
      RAG_OPENAI_API_KEY=$KEY
      IMAGES_OPENAI_API_KEY=$KEY
    '';
  };

  virtualisation.oci-containers.containers.open-webui = mkRootlessContainer {
    image = "ghcr.io/open-webui/open-webui:main@sha256:a26effeb220e132482bf7e0560b3404843e7bc40d23051144e062960df8df6b0";

    volumes = [ "${dataDir}:/app/backend/data" ];

    environment = {
      WEBUI_URL = "https://chat.toscanini.me";

      # Make env/nix the source of truth for admin config. Without this,
      # Open WebUI's PersistentConfig reads each env-backed setting ONCE
      # on first boot, stores it in the DB, and thereafter ignores env
      # changes (the DB value wins) — so later nix edits silently no-op
      # (hit with ENABLE_LOGIN_FORM). User DATA (chats, knowledge,
      # prompts) is separate and unaffected; only admin settings that
      # have env equivalents become env-authoritative.
      ENABLE_PERSISTENT_CONFIG = "false";

      # LLM chat: the gateway. The gateway ALSO exposes non-chat models
      # (whisper-1, nomic-embed, kokoro, z-image) that the media features
      # below consume — but those must NOT appear in the chat model
      # picker. OPENAI_API_CONFIGS pins the chat connection to an explicit
      # allowlist of just the two chat models. The RAG/AUDIO/IMAGES
      # settings reach their models by their own base-URL config, so this
      # filter doesn't affect them.
      ENABLE_OPENAI_API = "true";
      OPENAI_API_BASE_URL = "http://litellm:4000/v1";
      OPENAI_API_CONFIGS = builtins.toJSON {
        "http://litellm:4000/v1" = {
          enable = true;
          model_ids = [
            "gemma-4-12b"
            "gemma-4-12b-uncensored"
          ];
        };
      };
      # No bundled Ollama — LiteLLM is the only backend.
      ENABLE_OLLAMA_API = "false";

      # Audio in (STT) → gateway whisper-1 → Lemonade Whisper-Large-v3-Turbo
      # on the GPU (the litellm entry was repointed off CPU subgen).
      AUDIO_STT_ENGINE = "openai";
      AUDIO_STT_OPENAI_API_BASE_URL = "http://litellm:4000/v1";
      AUDIO_STT_MODEL = "whisper-1";

      # Audio out (TTS) → gateway kokoro → Lemonade kokoro on the GPU.
      AUDIO_TTS_ENGINE = "openai";
      AUDIO_TTS_OPENAI_API_BASE_URL = "http://litellm:4000/v1";
      AUDIO_TTS_MODEL = "kokoro";
      AUDIO_TTS_VOICE = "af_sky";

      # Web search via the private SearXNG. Both the new and legacy env
      # names are set so the toggle appears across image versions.
      ENABLE_WEB_SEARCH = "true";
      ENABLE_RAG_WEB_SEARCH = "true";
      WEB_SEARCH_ENGINE = "searxng";
      RAG_WEB_SEARCH_ENGINE = "searxng";
      SEARXNG_QUERY_URL = "http://searxng:8080/search?q=<query>";
      WEB_SEARCH_RESULT_COUNT = "5";
      WEB_SEARCH_CONCURRENT_REQUESTS = "10";

      # RAG/PDF embeddings → gateway nomic-embed → Lemonade on the GPU
      # (replaces the in-container MiniLM). 768-dim; Chroma vector store
      # stays in the data dir. NOTE: changing the embedding model needs a
      # knowledge-base re-index (dim mismatch) — only matters once docs
      # are indexed.
      RAG_EMBEDDING_ENGINE = "openai";
      RAG_OPENAI_API_BASE_URL = "http://litellm:4000/v1";
      RAG_EMBEDDING_MODEL = "nomic-embed";

      # Image generation → gateway z-image → Lemonade Z-Image-Turbo (GPU).
      # Ready but won't render until the Lemonade sd-server backend is
      # fixed (it was throwing backend_watchdog_reset at setup).
      ENABLE_IMAGE_GENERATION = "true";
      IMAGE_GENERATION_ENGINE = "openai";
      IMAGES_OPENAI_API_BASE_URL = "http://litellm:4000/v1";
      IMAGE_GENERATION_MODEL = "z-image";
      IMAGE_SIZE = "1024x1024";
      IMAGE_STEPS = "9";

      # Native OIDC SSO via Pocket ID (docs/features/.../auth/sso). The
      # client id/secret ride env.sops; issuer is the fleet SSO URL.
      # Local password login stays available as break-glass (login form
      # not disabled), matching grafana/n8n. New accounts come via SSO
      # only (ENABLE_SIGNUP=false); OAuth logins merge into an existing
      # account with the same email, so the admin account already made
      # keeps its role.
      ENABLE_OAUTH_SIGNUP = "true";
      OAUTH_MERGE_ACCOUNTS_BY_EMAIL = "true";
      # Skip the Open WebUI sign-in page — go straight to Pocket ID.
      # The frontend only auto-redirects when there's a single provider
      # (we have one) AND the login form is disabled — so
      # ENABLE_LOGIN_FORM MUST be false for the redirect to fire.
      # Break-glass local password login is still reachable at
      # /auth?form=true: the `form` query param both suppresses the
      # auto-redirect and force-renders the password fields (the render
      # gate is `enable_login_form || enable_ldap || form-param`).
      OAUTH_AUTO_REDIRECT = "true";
      ENABLE_LOGIN_FORM = "false";
      OAUTH_PROVIDER_NAME = "Pocket ID";
      OAUTH_SCOPES = "openid email profile";
      OPENID_PROVIDER_URL = "${config.fleet.sso.issuerUrl}/.well-known/openid-configuration";
      OPENID_REDIRECT_URI = "https://chat.toscanini.me/oauth/oidc/callback";
      ENABLE_SIGNUP = "false";
      DEFAULT_USER_ROLE = "pending";

      # Behind traefik — trust the forwarded proto/host.
      WEBUI_SESSION_COOKIE_SAME_SITE = "lax";
      WEBUI_SESSION_COOKIE_SECURE = "true";

      # OpenTelemetry metrics → alloy (the box's collector) over
      # monitoring-net. Open WebUI's exporter is OTLP/gRPC-only and
      # Prometheus's OTLP receiver is HTTP-only, so alloy bridges gRPC→HTTP
      # (see stacks/logging). Feeds the "AI" Grafana dashboard.
      ENABLE_OTEL = "true";
      ENABLE_OTEL_METRICS = "true";
      OTEL_SERVICE_NAME = "open-webui";
      OTEL_EXPORTER_OTLP_ENDPOINT = "http://alloy:4317";
      OTEL_EXPORTER_OTLP_INSECURE = "true";
      OTEL_METRICS_EXPORT_INTERVAL_MILLIS = "10000";

      # Don't phone home.
      SCARF_NO_ANALYTICS = "true";
      DO_NOT_TRACK = "true";
      ANONYMIZED_TELEMETRY = "false";
    };

    # DATABASE_URL from the app-db bootstrap; WEBUI_SECRET_KEY from the
    # first-boot secrets file; OPENAI_API_KEY (+ AUDIO_STT key) rendered
    # from the LiteLLM master key. Later files win on key collisions.
    environmentFiles = [
      config.fleet.appDatabases.open_webui.envFile
      webuiSecretFile
      litellmKeyFile
      config.sops.secrets."open-webui-env".path # OAUTH_CLIENT_ID/SECRET
    ];
  };

  virtualisation.oci-containers.containers.searxng = mkRootlessContainer {
    image = "docker.io/searxng/searxng:latest@sha256:419d2915279be335146a440fd0ad25c657738dde7046387c0d5592cb6aa472d2";

    volumes = [
      "${./assets/searxng/settings.yml}:/etc/searxng/settings.yml:ro"
    ];

    environment = {
      SEARXNG_BASE_URL = "http://searxng:8080/";
    };

    # SEARXNG_SECRET (machine-generated) overrides the placeholder
    # secret_key in settings.yml.
    environmentFiles = [ searxngSecretFile ];
  };
}
