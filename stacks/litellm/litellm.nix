# litellm — LLM gateway. Its database lives on the shared app-db
# cluster (stacks/app-db); the container joins app-db-net to dial `pg`
# and traefik-net so traefik dials `http://litellm:4000` — no host port.
#
# LiteLLM proxies LAN/cloud LLM endpoints behind one OpenAI-compatible
# API. The actual model server runs on the Windows gaming PC at
# gaming-pc.local.toscanini.me, kept alive there manually
# (`lemonade-server.exe serve --host 0.0.0.0 --port 13305`).
#
# Upstream model-server notes (lives on the gaming PC; recorded here
# because litellm is the only nix-side piece):
#   - Lemonade v10.0.1: https://github.com/lemonade-sdk/lemonade/releases
#   - ROCm vb1217: https://github.com/lemonade-sdk/llamacpp-rocm/releases/tag/b1217
#   - Currently runs Vulkan; ROCm fails to start. Try
#     `--llamacpp rocm`, pinning to discrete card with
#     `--llamacpp-args "--device ROCM1"` if the iGPU interferes.
#
# Note: `docker.litellm.ai` is sinkholed by
# pi-hole — use `ghcr.io/berriai/litellm:main-stable@sha256:65d84a2282137b4dc73bbe184650a7c807177c533e4223b3bfbc87963fe3fabe` instead.

{
  config,
  mkDotenvSecret,
  mkRootlessContainer,
  mkSecretRender,
  ...
}:

{
  # UI creds + LITELLM_MASTER_KEY + SSO client creds: sops-encrypted
  # env.sops, decrypted to /run/secrets/litellm-env. Edit with
  # `sops env.sops`. DATABASE_URL comes from the app-db-generated env
  # file, not from here.
  sops.secrets."litellm-env" = mkDotenvSecret ./env.sops;

  # Prometheus scrapes litellm's /metrics with a Bearer token that IS the
  # LITELLM_MASTER_KEY. `credentials_file` wants a file holding ONLY the
  # token, but env.sops is a full dotenv — so litellm-prom-token.service
  # extracts just the token from the already-decrypted /run/secrets/litellm-env
  # at boot and writes it to /run/litellm-prom-token/token. Same
  # activation-render idiom as app-db's app-db-exporter-env.
  #
  # The key has ONE encrypted source of truth (env.sops); every other
  # consumer (this token file, homepage's HOMEPAGE_VAR_LITELLM_KEY) is
  # rendered from it at boot — rotation touches only env.sops.
  # Gates prometheus: podman bind-mounts the token file at container start.
  systemd.services."litellm-prom-token" = mkSecretRender {
    description = "Render litellm master key as a bare bearer token for the prometheus scrape";
    gates = [ "podman-prometheus.service" ];
    dir = "/run/litellm-prom-token";
    file = "/run/litellm-prom-token/token";
    prep = "TOKEN=$(grep '^LITELLM_MASTER_KEY=' /run/secrets/litellm-env | head -1 | cut -d= -f2-)";
    content = "$TOKEN";
  };

  # This stack owns the token; it contributes the mount to prometheus
  # itself (list-merge with monitoring.nix's volumes) instead of
  # monitoring hardcoding a path into another stack's /run dir. The DIR
  # is mounted (not the file) so a re-render/rotation is picked up
  # without a prometheus restart — a single-file bind pins the old
  # inode until the container restarts.
  virtualisation.oci-containers.containers.prometheus.volumes = [
    "/run/litellm-prom-token:/run/secrets/litellm-prom-token:ro"
  ];

  fleet.bridgeMemberships.litellm = [
    "app-db"
    "traefik"
    "websearch" # dial searxng:8080 for the search_tool + interception
  ];

  # Database on the shared app-db cluster: role + db + env file with
  # DATABASE_URL, materialized by app-db-litellm-bootstrap.service
  # (see stacks/app-db/).
  fleet.appDatabases.litellm.consumers = [ "litellm" ];

  # Pocket ID client — id `litellm`, secret SSO_SECRET_LITELLM in
  # stacks/pocket-id/clients.sops, rendered into the container as the
  # GENERIC_* pair. PKCE stays off: litellm's GENERIC SSO sends no
  # code_challenge, which is also what makes AUTO_REDIRECT safe.
  fleet.ssoClients.litellm = {
    displayName = "LiteLLM";
    description = "OpenAI-compatible LLM gateway";
    launchURL = "https://litellm.toscanini.me/ui";
    callbackURLs = [ "https://litellm.toscanini.me/sso/callback" ];
    logoutCallbackURLs = [ "https://litellm.toscanini.me/sso/callback" ];
    pkce = false;
    consumers = [ "litellm" ];
    consumerEnv = {
      id = "GENERIC_CLIENT_ID";
      secret = "GENERIC_CLIENT_SECRET";
    };
  };

  fleet.webApps.litellm = {
    serviceName = "litellm";
    port = 4000;
    homepage = {
      group = "AI & Automation";
      name = "LiteLLM";
      href = "https://litellm.toscanini.me/ui";
      description = "OpenAI-compatible LLM gateway";
      icon = "/icons/litellm.png";
      # /global/spend is deliberately NOT used: every local model pins
      # cost to 0 and no budget is set, so it can only ever render $0/$0.
      # `widgets` (plural) rides `extra` — the submodule only declares the
      # singular `widget`, and `extra` is the verbatim tile-field escape.
      # Both rows read the SAME endpoint, which carries per-day `results`
      # (newest first) and a lifetime `metadata` roll-up — so today and
      # all-time come from one query and every number is window-labelled.
      #
      # The date range is pinned wide because a widget URL is static and
      # cannot compute "today"; `metadata.*` therefore means all-time.
      # Payload is ~150 KB and the query aggregates full history, so this
      # polls at 5 min — the counters are cumulative, not live gauges.
      extra.widgets = [
        # results.0 = most recent day WITH traffic. On a zero-traffic day
        # that is the last active day, not literally today.
        {
          type = "customapi";
          url = "http://litellm:4000/user/daily/activity/aggregated?start_date=2020-01-01&end_date=2030-12-31";
          refreshInterval = 300000;
          headers = {
            Authorization = "Bearer {{HOMEPAGE_VAR_LITELLM_KEY}}";
          };
          mappings = [
            {
              field = "results.0.metrics.api_requests";
              label = "Reqs today";
              format = "number";
            }
            {
              # The actionable failure number — the all-time counter
              # below is dominated by historical churn.
              field = "results.0.metrics.failed_requests";
              label = "Failed today";
              format = "number";
            }
            {
              field = "results.0.metrics.total_tokens";
              label = "Tokens today";
              format = "number";
            }
          ];
        }
        {
          type = "customapi";
          url = "http://litellm:4000/user/daily/activity/aggregated?start_date=2020-01-01&end_date=2030-12-31";
          refreshInterval = 300000;
          headers = {
            Authorization = "Bearer {{HOMEPAGE_VAR_LITELLM_KEY}}";
          };
          mappings = [
            {
              field = "metadata.total_api_requests";
              label = "Reqs all";
              format = "number";
            }
            {
              # Gateway-level errors (upstream down, model swapping,
              # bad key). Worth a permanent slot — nothing else on the
              # dashboard reports LiteLLM request failures.
              field = "metadata.total_failed_requests";
              label = "Failed all";
              format = "number";
            }
            {
              field = "metadata.total_tokens";
              label = "Tokens all";
              format = "number";
            }
          ];
        }
      ];
    };
  };

  # Prometheus on traefik-net scrapes by container DNS.
  fleet.prometheusScrapes = [
    {
      job_name = "litellm";
      # litellm serves the collector at /metrics/ and 307s the bare path,
      # so the default /metrics costs a redirect round-trip and two access
      # log lines on every scrape.
      metrics_path = "/metrics/";
      authorization = {
        type = "Bearer";
        credentials_file = "/run/secrets/litellm-prom-token/token";
      };
      static_configs = [ { targets = [ "litellm:4000" ]; } ];
    }
  ];

  # Merged "AI" dashboard: LiteLLM gateway panels + Open WebUI OTel
  # panels in one board (uid s2-ai), filed under the "AI" folder.
  fleet.grafanaDashboardsByFolder."AI".ai = builtins.readFile ./assets/dashboard.json;

  fleet.homepageServices."AI & Automation" = [
    {
      # External Windows-PC service — declared here because litellm is
      # the only nix-side piece of this dual-machine setup.
      name = "Lemonade";
      href = "http://gaming-pc.local.toscanini.me:13305/";
      description = "Local LLM model server on the gaming PC";
      icon = "/icons/lemonade.png";
      siteMonitor = "http://gaming-pc.local.toscanini.me:13305/";
      # Two widgets on one tile (homepage supports a `widgets` list).
      # No auth: LEMONADE_API_KEY is unset, so the LAN reaches the API
      # unauthenticated — no HOMEPAGE_VAR_* needed here.
      widgets = [
        # Resident-model summary. Listing every model is not worth the
        # rows: `max_models` is 1 per type and all six are pinned, so the
        # set is effectively fixed. `model_loaded` is the part that moves
        # — it tracks the most recently active model, so it flips to
        # churro-3B during a transcription run.
        {
          type = "customapi";
          url = "http://gaming-pc.local.toscanini.me:13305/api/v1/health";
          refreshInterval = 30000;
          mappings = [
            {
              # `size` on an array yields its length — the loaded count
              # without enumerating names.
              field = "all_models_loaded";
              label = "Models";
              format = "size";
            }
            {
              field = "model_loaded";
              label = "Hot";
              format = "text";
              # Raw ids ("Gemma-4-12B-it-MTP-GGUF") wrap to three lines at
              # widget value size and blow up the tile. Unmatched values
              # pass through untouched (component.jsx only rewrites on an
              # exact `value` hit or an `any` catch-all), so this list only
              # needs the models that actually reach the slot.
              remap = [
                {
                  value = "Gemma-4-12B-it-MTP-GGUF";
                  to = "Gemma";
                }
                {
                  value = "Gemma-4-12B-it-GGUF";
                  to = "Gemma";
                }
                {
                  value = "Huihui-Gemma-4-12B-uncensored";
                  to = "Gemma unc";
                }
                {
                  value = "churro-3B";
                  to = "Churro";
                }
                {
                  value = "Whisper-Large-v3-Turbo";
                  to = "Whisper";
                }
                {
                  value = "kokoro-v1";
                  to = "Kokoro";
                }
                {
                  value = "Qwen3-Embedding-0.6B-GGUF";
                  to = "Embed";
                }
                {
                  value = "bge-reranker-v2-m3-GGUF";
                  to = "Rerank";
                }
                {
                  value = "Z-Image-Turbo";
                  to = "Z-Image";
                }
                {
                  value = "Chroma1-HD";
                  to = "Chroma";
                }
                {
                  value = "Flux-2-Klein-9B-GGUF";
                  to = "Flux";
                }
              ];
            }
            {
              field = "version";
              label = "Ver";
              format = "text";
            }
          ];
        }
        # Serving performance. tokens_per_second / time_to_first_token are
        # the MOST RECENT request; the *_total fields are cumulative counters
        # held in the server process (they reset if Lemonade restarts —
        # unlike LiteLLM's, which are DB-backed).
        {
          type = "customapi";
          url = "http://gaming-pc.local.toscanini.me:13305/api/v1/stats";
          refreshInterval = 30000;
          mappings = [
            {
              field = "tokens_per_second";
              label = "Tok/s last";
              format = "number";
            }
            {
              # Seconds upstream; scaled to ms so a sub-second TTFT
              # doesn't render as a bare 0.
              field = "time_to_first_token";
              label = "TTFT last";
              format = "number";
              scale = 1000;
              suffix = " ms";
            }
            {
              field = "request_count_total";
              label = "Reqs total";
              format = "number";
            }
            {
              field = "output_tokens_total";
              label = "Out tok total";
              format = "number";
            }
          ];
        }
      ];
    }
  ];

  virtualisation.oci-containers.containers.litellm = mkRootlessContainer {
    image = "ghcr.io/berriai/litellm:main-stable@sha256:65d84a2282137b4dc73bbe184650a7c807177c533e4223b3bfbc87963fe3fabe";

    # config.yaml enables the prometheus callback (without
    # `callbacks: ["prometheus"]` in litellm_settings, /metrics 404s).
    # Store-mounted so a config change restarts the container.
    volumes = [
      "${./assets/config.yaml}:/app/config.yaml:ro"
    ];

    cmd = [
      "--config"
      "/app/config.yaml"
      "--port"
      "4000"
    ];

    environment = {
      # Pocket ID SSO for the admin UI (free ≤5 users; AUTH.md).
      # GENERIC_CLIENT_ID/SECRET ride env.sops. The OpenAI-compatible
      # API keeps Bearer virtual-key auth — SSO only changes the UI.
      PROXY_BASE_URL = "https://litellm.toscanini.me";
      GENERIC_AUTHORIZATION_ENDPOINT = "${config.fleet.sso.issuerUrl}/authorize";
      GENERIC_TOKEN_ENDPOINT = "${config.fleet.sso.issuerUrl}/api/oidc/token";
      GENERIC_USERINFO_ENDPOINT = "${config.fleet.sso.issuerUrl}/api/oidc/userinfo";
      # PKCE is disabled on the Pocket ID client (litellm's GENERIC SSO
      # sends no code_challenge), which makes the auto-redirect safe.
      AUTO_REDIRECT_UI_LOGIN_TO_SSO = "true";
      # SSO user_id litellm promotes to proxy_admin in its UserTable —
      # without this, SSO logins land as internal_user_viewer and the
      # UI shows no keys/models (docs/proxy/admin_ui_sso).
      PROXY_ADMIN_ID = "santito";
      STORE_MODEL_IN_DB = "True";
    };

    # UI_USERNAME/UI_PASSWORD + LITELLM_MASTER_KEY + SSO creds from
    # sops; DATABASE_URL (+ POSTGRES_*) from the app-db bootstrap env.
    # Later files win on key collisions.
    environmentFiles = [
      config.sops.secrets."litellm-env".path
      config.fleet.appDatabases.litellm.envFile
    ];

  };
}
