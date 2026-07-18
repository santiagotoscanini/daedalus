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
# Note: `docker.litellm.ai` (old compose used this) is sinkholed by
# pi-hole — use `ghcr.io/berriai/litellm:main-stable@sha256:9ef6f45bc0104940571765e610c52a1d761b5ec85efcd193795281086ee61277` instead.

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
  # at boot and writes it to /run/litellm-prom-token/token, which
  # monitoring.nix bind-mounts into prometheus. Same activation-render idiom
  # as app-db's pg-exporter-config.
  #
  # The key has ONE encrypted source of truth (env.sops). ONE copy
  # still needs manual sync on
  # rotation — stacks/homepage/env.sops HOMEPAGE_VAR_LITELLM_KEY (the homepage
  # tile substitutes its own var and can't read this rendered file).
  # Gates prometheus: podman bind-mounts the token file at container start.
  systemd.services."litellm-prom-token" = mkSecretRender {
    description = "Render litellm master key as a bare bearer token for the prometheus scrape";
    gates = [ "podman-prometheus.service" ];
    dir = "/run/litellm-prom-token";
    file = "/run/litellm-prom-token/token";
    prep = "TOKEN=$(grep '^LITELLM_MASTER_KEY=' /run/secrets/litellm-env | head -1 | cut -d= -f2-)";
    content = "$TOKEN";
  };

  myStack.containerNetworks.litellm = [ "app-db" "traefik" ];

  # The bootstrap gates `podman-app-<name>` for apps-platform tenants;
  # litellm is a stack, so pull it in explicitly.
  systemd.services.podman-litellm = {
    after = [ "app-db-litellm-bootstrap.service" ];
    wants = [ "app-db-litellm-bootstrap.service" ];
  };

  # Database on the shared app-db cluster: role + db + env file with
  # DATABASE_URL, materialized by app-db-litellm-bootstrap.service
  # (see stacks/app-db/).
  myStack.appDatabases.litellm = { };

  myStack.webApps.litellm = {
    serviceName = "litellm";
    port = 4000;
    homepage = {
      group = "Cloud & AI";
      name = "LiteLLM";
      href = "https://litellm.toscanini.me/ui";
      description = "OpenAI-compatible LLM gateway (lemonade on gaming-pc)";
      icon = "/icons/litellm.png";
      widget = {
        type = "customapi";
        # /global/spend → {"spend": <num>, "max_budget": <num>}.
        # Both render as $0/$0 until you wire a billed provider; the
        # tile is also an "alive" signal — a 401/non-200 will show
        # the API error in the widget.
        url = "http://litellm:4000/global/spend";
        refreshInterval = 60000;
        headers = {
          Authorization = "Bearer {{HOMEPAGE_VAR_LITELLM_KEY}}";
        };
        mappings = [
          {
            field = "spend";
            label = "Spend";
            format = "number";
            prefix = "$";
          }
          {
            field = "max_budget";
            label = "Budget";
            format = "number";
            prefix = "$";
          }
        ];
      };
    };
  };

  # Prometheus on traefik-net scrapes by container DNS.
  myStack.prometheusScrapes = [
    {
      job_name = "litellm";
      authorization = {
        type = "Bearer";
        credentials_file = "/run/secrets/litellm-prom-token/token";
      };
      static_configs = [ { targets = [ "litellm:4000" ]; } ];
    }
  ];

  myStack.grafanaDashboardsByFolder."Services".litellm = builtins.readFile ./assets/dashboard.json;

  myStack.homepageServices."Cloud & AI" = [
    {
      # External Windows-PC service — declared here because litellm is
      # the only nix-side piece of this dual-machine setup.
      name = "Lemonade";
      href = "http://gaming-pc.local.toscanini.me:13305/";
      description = "Local LLM model server on the gaming PC (Vulkan/ROCm)";
      icon = "/icons/lemonade.png";
      siteMonitor = "http://gaming-pc.local.toscanini.me:13305/";
    }
  ];


  virtualisation.oci-containers.containers.litellm = mkRootlessContainer {
    image = "ghcr.io/berriai/litellm:main-stable@sha256:9ef6f45bc0104940571765e610c52a1d761b5ec85efcd193795281086ee61277";

    # config.yaml enables the prometheus callback (without
    # `callbacks: ["prometheus"]` in litellm_settings, /metrics 404s).
    volumes = [
      "/etc/nixos/stacks/litellm/assets/config.yaml:/app/config.yaml:ro"
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
      GENERIC_AUTHORIZATION_ENDPOINT = "https://id.toscanini.me/authorize";
      GENERIC_TOKEN_ENDPOINT = "https://id.toscanini.me/api/oidc/token";
      GENERIC_USERINFO_ENDPOINT = "https://id.toscanini.me/api/oidc/userinfo";
      # PKCE is disabled on the Pocket ID client (litellm's GENERIC SSO
      # sends no code_challenge); safe to auto-redirect now.
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
      "/etc/nixos/stacks/app-db/secrets/litellm/env"
    ];

    extraOptions = [
    ];
  };
}
