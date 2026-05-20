# litellm — LLM gateway + postgres on litellm-net.
#
# LiteLLM proxies LAN/cloud LLM endpoints behind one OpenAI-compatible
# API. The actual model server runs on the Windows gaming PC at
# gaming-pc.local.toscanini.me — kept alive there manually
# (`lemonade-server.exe serve --host 0.0.0.0 --port 13305`).
#
# Upstream model-server notes (lives on the gaming PC, recorded here
# because litellm is the only piece of the puzzle declared in nix):
#   - Lemonade v10.0.1: https://github.com/lemonade-sdk/lemonade/releases
#   - ROCm vb1217 (llamacpp-rocm):
#       https://github.com/lemonade-sdk/llamacpp-rocm/releases/tag/b1217
#   - Currently runs on Vulkan because ROCm fails to start. Try
#     `--llamacpp rocm` to force ROCm, and if the embedded iGPU
#     interferes, pin to the discrete card with
#     `--llamacpp-args "--device ROCM1"`.
#
# Healthchecks: the old compose had liveness probes for both litellm
# (`urllib.request.urlopen('http://localhost:4000/health/liveliness')`)
# and litellm-db (`pg_isready -d litellm -U llmproxy`). Dropped on
# migration — systemd `Type=oneshot + RemainAfterExit=true` ignores
# them anyway. Recorded here in case we add a health watcher later.
#
# `docker.litellm.ai` (used by the old compose) is blocked by pi-hole,
# so we use the equivalent `ghcr.io/berriai/litellm:main-stable`.

{ mkRootlessContainer, ... }:

{
  myStack.containerNetworks = {
    litellm-db = "litellm";
    litellm    = "litellm";
  };

  myStack.traefikRoutes.litellm = {
    host = "litellm.s2.toscanini.me";
    port = 4000;
  };


  myStack.dnsHosts = [ "192.168.0.2 litellm.s2.toscanini.me" ];

  myStack.prometheusScrapes = [{
    job_name = "litellm";
    authorization = {
      type = "Bearer";
      credentials = "ROTATED-2026-07-15";
    };
    static_configs = [{ targets = [ "host.containers.internal:4000" ]; }];
  }];


  myStack.grafanaDashboards.litellm = builtins.readFile ./assets/dashboard.json;
  myStack.homepageServices."Cloud & AI" = [
    {
      name = "LiteLLM";
      href = "https://litellm.s2.toscanini.me/ui";
      description = "OpenAI-compatible LLM gateway (lemonade on gaming-pc)";
      icon = "mdi-robot-happy-#a78bfa";
      siteMonitor = "http://host.containers.internal:4000";
    }
    {
      # External — runs on the Windows gaming PC, declared here because
      # litellm is the only NixOS-side piece of this dual-machine setup.
      name = "Lemonade";
      href = "http://gaming-pc.local.toscanini.me:13305/";
      description = "Local LLM model server on the gaming PC (Vulkan/ROCm)";
      icon = "mdi-lemon-#facc15";
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
    environmentFiles = [ "/etc/nixos/stacks/litellm/secrets/env" ];

    extraOptions = [
      "--network=litellm-net"
    ];
  };

  virtualisation.oci-containers.containers.litellm = mkRootlessContainer {
    image = "ghcr.io/berriai/litellm:main-stable";
    dependsOn = [ "litellm-db" ];

    ports = [ "4000:4000" ];

    # Mount the YAML config that enables the prometheus callback.
    # Without `callbacks: ["prometheus"]` in litellm_settings the
    # /metrics endpoint returns 404. Config file lives next to the env
    # file under /etc/nixos so it's reproducible.
    volumes = [
      "/etc/nixos/stacks/litellm/assets/config.yaml:/app/config.yaml:ro"
    ];

    cmd = [ "--config" "/app/config.yaml" "--port" "4000" ];

    environment = {
      STORE_MODEL_IN_DB = "True";
    };

    # DATABASE_URL + UI_USERNAME/UI_PASSWORD + LITELLM_MASTER_KEY.
    environmentFiles = [ "/etc/nixos/stacks/litellm/secrets/env" ];

    extraOptions = [
      "--network=litellm-net"
    ];
  };
}
