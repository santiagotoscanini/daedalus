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
  # consumer (this token file, daedalus's LITELLM_API_KEY) is rendered
  # from it at boot — rotation touches only env.sops.
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

  # Pocket ID client — id `litellm`, secret generated on the box,
  # rendered into the container as the
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
