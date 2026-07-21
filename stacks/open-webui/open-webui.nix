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
# SSO (Pocket ID) is NOT wired yet — it needs an OIDC client created in
# the Pocket ID admin UI (callback https://chat.toscanini.me/oauth/oidc/
# callback), whose id/secret then land in a tracked env.sops. Until
# then local sign-up is on and the first account becomes admin.
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
    content = ''
      OPENAI_API_KEY=$KEY
      AUDIO_STT_OPENAI_API_KEY=$KEY
    '';
  };

  virtualisation.oci-containers.containers.open-webui = mkRootlessContainer {
    image = "ghcr.io/open-webui/open-webui:main@sha256:a26effeb220e132482bf7e0560b3404843e7bc40d23051144e062960df8df6b0";

    volumes = [ "${dataDir}:/app/backend/data" ];

    environment = {
      WEBUI_URL = "https://chat.toscanini.me";

      # LLM: every model registered on the gateway shows up here.
      ENABLE_OPENAI_API = "true";
      OPENAI_API_BASE_URL = "http://litellm:4000/v1";
      # No bundled Ollama — LiteLLM is the only backend.
      ENABLE_OLLAMA_API = "false";

      # Audio → LiteLLM whisper-1 → subgen. Talk to it; transcripts are
      # metered through the gateway like everything else.
      AUDIO_STT_ENGINE = "openai";
      AUDIO_STT_OPENAI_API_BASE_URL = "http://litellm:4000/v1";
      AUDIO_STT_MODEL = "whisper-1";

      # Web search via the private SearXNG. Both the new and legacy env
      # names are set so the toggle appears across image versions.
      ENABLE_WEB_SEARCH = "true";
      ENABLE_RAG_WEB_SEARCH = "true";
      WEB_SEARCH_ENGINE = "searxng";
      RAG_WEB_SEARCH_ENGINE = "searxng";
      SEARXNG_QUERY_URL = "http://searxng:8080/search?q=<query>";
      WEB_SEARCH_RESULT_COUNT = "5";
      WEB_SEARCH_CONCURRENT_REQUESTS = "10";

      # RAG/PDF: built-in local embeddings (default engine) + Chroma,
      # persisted in the data dir. No extra service needed.

      # Local sign-up on until Pocket ID SSO is wired; the FIRST account
      # is promoted to admin automatically, any later ones land in
      # `pending` (need admin approval) rather than auto-admin.
      ENABLE_SIGNUP = "true";
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
