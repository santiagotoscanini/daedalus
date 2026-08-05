# open-webui — ChatGPT-style frontend for the local models behind
# LiteLLM. Its database lives on the shared app-db cluster (role/db
# `open-webui`); the container joins:
#   - app-db-net    → dial `pg` for chats/settings
#   - traefik-net   → traefik dials `http://open-webui:8080`, AND
#                     open-webui dials `http://litellm:4000` (LLM + STT)
#   - websearch-net → shared bridge to searxng (now owned by the litellm
#                     stack; OWU is one of its two consumers)
#
# Capabilities wired here:
#   - Chat/vision   → LiteLLM `gemma-4-12b` (has vision + tool-calling)
#   - Audio (STT)   → LiteLLM `whisper-1` → subgen (tv stack)
#   - PDF/RAG       → embeddings via LiteLLM `qwen3-embed` (Lemonade,
#                     1024-dim) + local cross-encoder reranker; vectors
#                     stored in pgvector on the shared cluster (Open
#                     WebUI's own tables in the open_webui db).
#   - Web search    → SearXNG (searxng:8080, JSON API). The container
#                     lives in the litellm stack (the gateway owns the
#                     web-search capability); OWU dials it directly over
#                     the shared `websearch` bridge.
#
# SSO: native OIDC against Pocket ID. The client is declarative
# (fleet.ssoClients.open-webui below); its creds are rendered in as
# OAUTH_CLIENT_ID/SECRET. Local password login stays as break-glass;
# new accounts are SSO-only, merged by email.
#
# Secrets:
#   - WEBUI_SECRET_KEY → machine-generated on first boot into secrets/
#     (gitignored). Rotate = delete file + rebuild. (SEARXNG_SECRET moved
#     to the litellm stack along with the searxng container.)
#   - OPENAI_API_KEY (and the five other names the image reads for the
#     same credential) → its OWN virtual key at the gateway, declared as
#     fleet.litellmKeys.open-webui and generated on the box. It used to
#     be the LiteLLM MASTER key, which is the admin credential — a chat
#     UI holding the thing that mints keys and reads every caller's
#     ledger. The switch also makes this app nameable in the gateway's
#     own ledger instead of anonymous inside `master key`.

{
  config,
  pkgs,
  mkRootlessContainer,
  mkSecretRender,
  ...
}:

let
  dataDir = "/home/santiago/selfhost/open-webui/data";
  secretsDir = "/home/santiago/selfhost/open-webui/secrets";
  webuiSecretFile = "${secretsDir}/webui-env";
  litellmKeyFile = "/run/open-webui-litellm/env";
in
{
  fleet.bridgeMemberships.open-webui = [
    "app-db"
    "traefik"
    "websearch" # dial searxng:8080 (searxng lives in the litellm stack)
    "monitoring" # push OTLP metrics to alloy:4317 (the box's collector)
  ];

  fleet.statePaths."${dataDir}".uid = 0; # container root → santiago:users

  # Its own virtual key at the gateway, generated on the box and
  # converged into litellm by stacks/litellm/keys.nix. Unrestricted
  # `models` because this consumer legitimately uses the whole gateway —
  # chat, embeddings, reranking, transcription, speech and images are all
  # one product here, and a list would be a list of everything.
  #
  # It replaces the master key, which is the ADMIN credential: a chat UI
  # holding the thing that mints keys and reads every caller's ledger was
  # a privilege grant nobody chose. It is also why the dashboard's caller
  # list showed one row reaching seven models — every consumer configured
  # with the master key is indistinguishable from every other.
  #
  # `models` stays unrestricted because this consumer legitimately uses
  # the whole gateway — chat, embeddings, reranking, transcription,
  # speech and images are all one product here, and the list would be a
  # list of everything. The tool permissions are NOT optional: a virtual
  # key reaches no MCP server by default, and `tools/list` answers that
  # with an empty array rather than an error, so leaving them out
  # produces a chat window whose tools have quietly disappeared.
  fleet.litellmKeys.open-webui = {
    mcpServers = [
      "TickTick"
      "Grocy"
    ];
    searchTools = [ "searxng" ];
    # Nothing here covers RAG_EXTERNAL_RERANKER_URL below: `/reranking`
    # is a pass-through route, and open-source LiteLLM has no way to
    # authorise a virtual key for one. It is unauthenticated instead —
    # the argument is in stacks/litellm/assets/config.yaml.
    consumers = [ "open-webui" ];
    # One credential, six doors: the image reads a separate variable for
    # chat, transcription, speech, embeddings, images and reranking.
    consumerEnv = [
      "OPENAI_API_KEY"
      "AUDIO_STT_OPENAI_API_KEY"
      "AUDIO_TTS_OPENAI_API_KEY"
      "RAG_OPENAI_API_KEY"
      "IMAGES_OPENAI_API_KEY"
      "RAG_EXTERNAL_RERANKER_API_KEY"
    ];
  };

  # Loki stack label (alloy tags journal lines). searxng's label moved to
  # the litellm stack with its container.
  fleet.logStacks.open-webui = [ "open-webui" ];

  # Postgres role/db `open_webui` (underscore — the bootstrap raw-
  # interpolates the name into ALTER ROLE/GRANT, so no hyphens) + env
  # file with DATABASE_URL, from app-db-open_webui-bootstrap.service.
  # `vector` extension: RAG uses pgvector as its vector store (below),
  # in this same db (PGVECTOR_DB_URL defaults to DATABASE_URL).
  fleet.appDatabases.open_webui = {
    consumers = [ "open-webui" ];
    extensions = [ "vector" ];
  };

  # Pocket ID client — id `open-webui`, secret generated on the box,
  # rendered into the container as the
  # OAUTH_CLIENT_* pair. Deliberately NOT group-restricted: this is the
  # one client any Pocket ID account may use (chat is the household's
  # front door), matching what the IdP has enforced since it was made
  # by hand. PKCE off — Open WebUI's OIDC client sends no verifier.
  fleet.ssoClients.open-webui = {
    displayName = "Open WebUI";
    allowedGroups = [ ];
    callbackURLs = [ "https://chat.toscanini.me/oauth/oidc/callback" ];
    logoutCallbackURLs = [ "https://chat.toscanini.me" ];
    pkce = false;
    consumers = [ "open-webui" ];
    consumerEnv = {
      id = "OAUTH_CLIENT_ID";
      secret = "OAUTH_CLIENT_SECRET";
    };
  };

  fleet.webApps.open-webui = {
    hostname = "chat.toscanini.me";
    serviceName = "open-webui";
    port = 8080;
    healthPath = "/health"; # gatus probes the real upstream (unauthenticated 200)
  };

  # Machine-generated secrets, born on the box on first boot. Idempotent:
  # each file is created only if missing (delete + rebuild to rotate).
  systemd.services."open-webui-secrets-bootstrap" = {
    description = "Bootstrap open-webui: generate WEBUI_SECRET_KEY on first boot";
    before = [ "podman-open-webui.service" ];
    wantedBy = [ "podman-open-webui.service" ];
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
    '';
  };

  # TOOL_SERVER_CONNECTIONS, which is the one shape `consumerEnv` above
  # cannot express: the key is embedded inside a JSON blob rather than
  # standing alone as a variable. So it is rendered here, from the same
  # generated key, read out of the state file the registry exposes.
  #
  # The six plain variables that used to live here are gone — they are
  # `fleet.litellmKeys.open-webui.consumerEnv` now, and they carry this
  # app's OWN key rather than the gateway's admin credential.
  systemd.services."open-webui-litellm-key" = mkSecretRender {
    description = "Render the open-webui LiteLLM key into its MCP tool-server connections";
    gates = [ "podman-open-webui.service" ];
    dir = "/run/open-webui-litellm";
    file = litellmKeyFile;
    # After the generator, not after the gateway: the value exists before
    # litellm knows about it, and waiting on convergence would make this
    # app's start depend on the gateway being up.
    after = [ "litellm-key-secrets.service" ];
    wants = [ "litellm-key-secrets.service" ];
    prep = ''
      KEY=$(grep '^${config.fleet.litellmKeys.open-webui.envVar}=' ${
        config.fleet.litellmKeys.open-webui.secretsFile
      } | head -1 | cut -d= -f2-)
      [ -n "$KEY" ] || { echo "open-webui litellm key missing" >&2; exit 1; }
    '';
    # TOOL_SERVER_CONNECTIONS declares the LiteLLM MCP gateways (TickTick,
    # Grocy) as Open WebUI tool servers DECLARATIVELY. They MUST live here,
    # not the UI: `tool_server.connections` is an env-backed PersistentConfig,
    # so with ENABLE_PERSISTENT_CONFIG=false a UI-added connection is wiped
    # to `[]` on the next restart. The Bearer key is injected here so it
    # stays out of /nix/store. LiteLLM serves each MCP server at
    # /<alias>/mcp (aliases in stacks/litellm/assets/config.yaml), and the
    # key must be permitted to reach them — see `mcpServers` above.
    content = ''
      TOOL_SERVER_CONNECTIONS=[{"type":"mcp","url":"http://litellm:4000/TickTick/mcp","spec_type":"url","spec":"","path":"openapi.json","auth_type":"bearer","key":"$KEY","config":{"enable":true,"function_name_filter_list":"","access_grants":[]},"info":{"id":"ticktick","name":"TickTick","description":"TickTick tasks/lists/habits"}},{"type":"mcp","url":"http://litellm:4000/Grocy/mcp","spec_type":"url","spec":"","path":"openapi.json","auth_type":"bearer","key":"$KEY","config":{"enable":true,"function_name_filter_list":"","access_grants":[]},"info":{"id":"grocy","name":"Grocy","description":"Grocy household inventory, chores, shopping lists"}}]
    '';
  };

  virtualisation.oci-containers.containers.open-webui = mkRootlessContainer {
    image = "ghcr.io/open-webui/open-webui:main@sha256:6a773e5c3a246b65cbe74ce942b294292c0e5f81c138f703d111bc162f7d7c3d";

    volumes = [ "${dataDir}:/app/backend/data" ];

    environment = {
      WEBUI_URL = "https://chat.toscanini.me";

      # Unset, this defaults to `*` and the app warns about it at every
      # start. Only its own origin ever calls the API.
      CORS_ALLOW_ORIGIN = "https://chat.toscanini.me";

      # langchain's fetchers warn when unset, and RAG page fetches go out
      # with a default UA that some sites reject.
      USER_AGENT = "s2-server-open-webui";

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
      # Drop the built-in "Arena Model" from the picker (model A/B eval).
      ENABLE_EVALUATION_ARENA_MODELS = "false";

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

      # Web search via SearXNG (searxng:8080, in the litellm stack, over
      # the shared websearch bridge).
      ENABLE_WEB_SEARCH = "true";
      WEB_SEARCH_ENGINE = "searxng";
      SEARXNG_QUERY_URL = "http://searxng:8080/search?q=<query>";
      WEB_SEARCH_RESULT_COUNT = "5";
      WEB_SEARCH_CONCURRENT_REQUESTS = "10";

      # RAG/PDF embeddings → gateway qwen3-embed → Lemonade
      # Qwen3-Embedding-0.6B on the GPU (1024-dim). NOTE: switching the
      # embedding model needs a knowledge-base re-index (dim mismatch) —
      # only matters once docs are indexed.
      RAG_EMBEDDING_ENGINE = "openai";
      RAG_OPENAI_API_BASE_URL = "http://litellm:4000/v1";
      RAG_EMBEDDING_MODEL = "qwen3-embed";

      # Vector store: pgvector on the shared cluster (Open WebUI's own
      # tables in the open_webui db — PGVECTOR_DB_URL defaults to
      # DATABASE_URL), replacing the local Chroma file so RAG storage
      # rides the cluster backup. This is Open WebUI's *own* RAG store —
      # unrelated to the litellm-pgvector connector store (that one is
      # for programmatic/API RAG; Open WebUI can't consume it).
      # Pin the column dimension to qwen3-embed's 1024 (default 1536
      # would zero-pad every vector). <2000 → plain `vector`, no halfvec.
      # The extension is pre-created by the app-db bootstrap; Open WebUI
      # also runs CREATE EXTENSION IF NOT EXISTS (PGVECTOR_CREATE_EXTENSION
      # default true) — idempotent.
      VECTOR_DB = "pgvector";
      PGVECTOR_INITIALIZE_MAX_VECTOR_LENGTH = "1024";

      # RAG reranker — second-stage precision. Hybrid search retrieves a
      # wider candidate set, then a cross-encoder re-scores query+chunk
      # jointly and keeps the best. Reranker runs on the Lemonade GPU
      # (bge-reranker-v2-m3-GGUF) via LiteLLM's /reranking pass-through:
      # OWUI's ExternalReranker POSTs {model,query,documents,top_n} and reads
      # results[].relevance_score — an exact match for Lemonade's Cohere-shaped
      # reply. Freeze-safe on OWUI >=0.6.42 (the blocking POST is offloaded to
      # a thread via asyncio.to_thread; #19900). Key = master key (above).
      ENABLE_RAG_HYBRID_SEARCH = "true";
      RAG_RERANKING_ENGINE = "external";
      RAG_EXTERNAL_RERANKER_URL = "http://litellm:4000/reranking";
      RAG_RERANKING_MODEL = "bge-reranker-v2-m3-GGUF"; # Lemonade id (sent as `model`)
      RAG_TOP_K_RERANKER = "10"; # fetch 10 candidates, rerank down to TOP_K
      # Chunks fed to the model after reranking. Default 3 is tight for a
      # real knowledge base; gemma-4-12b has a 245k context, so keep more
      # of the reranked winners for better-grounded answers.
      RAG_TOP_K = "6";

      # Image generation → gateway z-image → Lemonade Z-Image-Turbo (GPU).
      # z-image is turbo: few steps, fast, reliable, good prompt adherence.
      # chroma/flux-klein stay gateway-reachable per request (single-model).
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

      # Programmatic access (daedalus reads the admin API).
      # Note the PLURAL name — `ENABLE_API_KEY` is a different, unrelated
      # setting and silently does nothing here. Upstream default is
      # "False", and the flag gates key creation for EVERY role: the
      # permission check ORs it ahead of the admin bypass, so with it off
      # even an admin gets 403 and the Account → API Keys section is
      # hidden. UI-toggling it would not survive a restart under
      # ENABLE_PERSISTENT_CONFIG=false, so it is declared here.
      ENABLE_API_KEYS = "true";

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
    ];
  };
}
