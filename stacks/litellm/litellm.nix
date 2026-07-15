# litellm — LLM gateway + postgres on litellm-net. The gateway also
# joins traefik-net so traefik dials `http://litellm:4000` — no host port.
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
# pi-hole — use `ghcr.io/berriai/litellm:main-stable` instead.

{ config, mkRootlessContainer, ... }:

{
  # DATABASE_URL + UI creds + LITELLM_MASTER_KEY: sops-encrypted env.sops, decrypted to
  # /run/secrets/litellm-env at activation. Edit with `sops env.sops`.
  sops.secrets."litellm-env" = {
    sopsFile = ./env.sops;
    format   = "dotenv";
    key      = "";
    owner    = "santiago";
  };

  myStack.containerNetworks = {
    litellm-db = "litellm";
    litellm    = "litellm";
  };

  myStack.webApps.litellm = {
    hostname = "litellm.toscanini.me";
    serviceName = "litellm";
    port = 4000;
  };

  # Prometheus on traefik-net scrapes by container DNS.
  myStack.prometheusScrapes = [{
    job_name = "litellm";
    authorization = {
      type = "Bearer";
      credentials = "c0*WtyxUN#fFBzxfArCda5mF";
    };
    static_configs = [{ targets = [ "litellm:4000" ]; }];
  }];

  myStack.grafanaDashboards.litellm = builtins.readFile ./assets/dashboard.json;

  myStack.homepageServices."Cloud & AI" = [
    {
      name = "LiteLLM";
      href = "https://litellm.toscanini.me/ui";
      description = "OpenAI-compatible LLM gateway (lemonade on gaming-pc)";
      icon = "/icons/litellm.png";
      siteMonitor = "http://litellm:4000";
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
          { field = "spend"; label = "Spend"; format = "number"; prefix = "$"; }
          { field = "max_budget"; label = "Budget"; format = "number"; prefix = "$"; }
        ];
      };
    }
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

  virtualisation.oci-containers.containers.litellm-db = mkRootlessContainer {
    image = "docker.io/library/postgres:16-alpine";

    volumes = [
      "/home/santiago/selfhost/litellm/db:/var/lib/postgresql/data"
    ];

    environment = {
      POSTGRES_DB = "litellm";
      POSTGRES_USER = "llmproxy";
    };

    # POSTGRES_PASSWORD shared with litellm (DATABASE_URL).
    environmentFiles = [ config.sops.secrets."litellm-env".path ];

    extraOptions = [
      "--network=litellm-net"
    ];
  };

  virtualisation.oci-containers.containers.litellm = mkRootlessContainer {
    image = "ghcr.io/berriai/litellm:main-stable";
    dependsOn = [ "litellm-db" ];

    # config.yaml enables the prometheus callback (without
    # `callbacks: ["prometheus"]` in litellm_settings, /metrics 404s).
    volumes = [
      "/etc/nixos/stacks/litellm/assets/config.yaml:/app/config.yaml:ro"
    ];

    cmd = [ "--config" "/app/config.yaml" "--port" "4000" ];

    environment = {
      STORE_MODEL_IN_DB = "True";
    };

    # DATABASE_URL + UI_USERNAME/UI_PASSWORD + LITELLM_MASTER_KEY.
    environmentFiles = [ config.sops.secrets."litellm-env".path ];

    extraOptions = [
      "--network=litellm-net"
      "--network=traefik-net"
    ];
  };
}
