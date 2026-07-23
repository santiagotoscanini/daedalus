# litellm-pgvector — the connector that gives LiteLLM a PG Vector
# vector store. It is NOT LiteLLM talking to Postgres directly:
# `pg_vector` in LiteLLM is a separate service (BerriAI/litellm-pgvector,
# a FastAPI/Prisma app) exposing OpenAI-compatible /v1/vector_stores
# endpoints. LiteLLM dials it over traefik-net; the connector stores
# embeddings in the `litellm_vector` database on the shared app-db
# cluster and calls back to `litellm:4000` to embed content/queries
# (qwen3-embed on Lemonade).
#
# Registration is DB state, not config: because litellm runs with
# STORE_MODEL_IN_DB=True, a config.yaml vector_store_registry entry gets
# dropped at runtime. Register each store in LiteLLM's DB instead:
#   POST http://litellm:4000/vector_store/new
#     { vector_store_id, custom_llm_provider: "pg_vector",
#       litellm_params: { api_base: "http://litellm-pgvector:8000",
#                         api_key: <PGVECTOR_SERVER_API_KEY> } }
# (like a virtual key — covered by the litellm DB backup, re-create on a
# DB wipe). PGVECTOR_SERVER_API_KEY lives in litellm/env.sops.
#
# Data flow:
#   client → litellm:4000 (vector_store_ids) → litellm-pgvector:8000
#           → pg (pgvector similarity search) → context injected → LLM
#   ingest → litellm-pgvector:8000 /v1/vector_stores/{id}/embeddings
#           → embed via litellm:4000 → pg
#
# Internal only — no webApp. Reached solely by litellm over the bridge.
# Ingestion is done from the LAN via the connector's REST API (e.g. a
# throwaway `podman run --network=traefik-net curlimages/curl ...`).
#
# Caveat: LiteLLM's *UI* RAG ingestion does not support pg_vector
# (BerriAI/litellm#26771). Retrieval at completion time works; populate
# stores through the connector API directly, not the LiteLLM dashboard.
#
# No published image exists, so the image is built from a pinned source
# checkout (mkLocalImage). The upstream schema hardcodes vector(1536);
# our local embedding model (qwen3-embed) is 1024-dim, so the build
# context patches the dimension to match.

{
  config,
  pkgs,
  mkLocalImage,
  mkRootlessContainer,
  mkSecretRender,
  ...
}:

let
  src = pkgs.fetchFromGitHub {
    owner = "BerriAI";
    repo = "litellm-pgvector";
    rev = "b553f84a32f580b4303297df5567f25912b59d93";
    hash = "sha256-9Ar4NLe2Xqnz/8spuSSf+MMxTRMqcxiWHX8iN5qvGV4=";
  };

  # Build context: the upstream tree with two edits —
  #   1. vector(1536) → vector(1024) to match qwen3-embed's dimension.
  #   2. Dockerfile copied to Containerfile (mkLocalImage builds with
  #      `--file Containerfile`; upstream ships a Dockerfile).
  buildContext = pkgs.runCommand "litellm-pgvector-context" { } ''
    mkdir -p $out
    cp -r ${src}/. $out/
    chmod -R u+w $out
    substituteInPlace $out/prisma/schema.prisma \
      --replace-fail 'vector(1536)' 'vector(1024)'
    cp $out/Dockerfile $out/Containerfile
  '';

  connectorImage = mkLocalImage {
    name = "litellm-pgvector";
    tagPrefix = "b553f84";
    contextDir = buildContext;
    gates = [ "podman-litellm-pgvector.service" ];
  };
in
{
  # Its own database on the shared cluster, with the pgvector extension
  # created by the bootstrap. `consumers` gates the container after the
  # role/db/extension/env file exist.
  fleet.appDatabases.litellm_vector = {
    extensions = [ "vector" ];
    consumers = [ "litellm-pgvector" ];
  };

  # app-db to reach `pg`; traefik-net for the bidirectional calls with
  # litellm (litellm → connector for search, connector → litellm:4000
  # for embeddings). Not published — no host port, no webApp.
  fleet.bridgeMemberships.litellm-pgvector = [
    "app-db"
    "traefik"
  ];

  # SERVER_API_KEY (the connector's own bearer auth, also used by
  # litellm's vector_store_registry api_key) and EMBEDDING__API_KEY (the
  # LiteLLM master key, to call litellm:4000). Both derive from the
  # single source of truth in litellm/env.sops — rotation touches only
  # that file. Read as an env file at container start (a restart picks
  # up a re-render).
  systemd.services.litellm-pgvector-secrets = mkSecretRender {
    description = "Render litellm-pgvector SERVER_API_KEY + embedding key from the litellm master secret";
    gates = [ "podman-litellm-pgvector.service" ];
    dir = "/run/litellm-pgvector-env";
    file = "/run/litellm-pgvector-env/env";
    owner = "santiago";
    prep = ''
      MASTER=$(grep '^LITELLM_MASTER_KEY=' /run/secrets/litellm-env | head -1 | cut -d= -f2-)
      SRVKEY=$(grep '^PGVECTOR_SERVER_API_KEY=' /run/secrets/litellm-env | head -1 | cut -d= -f2-)
    '';
    content = ''
      SERVER_API_KEY=''${SRVKEY}
      EMBEDDING__API_KEY=''${MASTER}
    '';
  };

  systemd.services.litellm-pgvector-image-build = connectorImage.service;

  virtualisation.oci-containers.containers.litellm-pgvector = mkRootlessContainer {
    inherit (connectorImage) image;

    # Apply the Prisma schema on first boot, then serve (see entrypoint).
    volumes = [
      "${./assets/entrypoint.sh}:/entrypoint.sh:ro"
    ];
    cmd = [
      "sh"
      "/entrypoint.sh"
    ];

    environment = {
      HOST = "0.0.0.0";
      PORT = "8000";
      # Embeddings via the LiteLLM gateway → Lemonade Qwen3-Embedding
      # (1024-dim; matches the patched schema column). The connector
      # embeds through the litellm SDK, which needs a provider prefix to
      # treat EMBEDDING__BASE_URL as OpenAI-compatible — `openai/` makes
      # it POST model=qwen3-embed to the proxy (which then routes to
      # Lemonade). A bare name errors "LLM Provider NOT provided".
      EMBEDDING__MODEL = "openai/qwen3-embed";
      EMBEDDING__BASE_URL = "http://litellm:4000";
      EMBEDDING__DIMENSIONS = "1024";
    };

    # DATABASE_URL (→ pg:5432/litellm_vector) from the app-db bootstrap
    # env file; SERVER_API_KEY + EMBEDDING__API_KEY from the render above.
    environmentFiles = [
      config.fleet.appDatabases.litellm_vector.envFile
      "/run/litellm-pgvector-env/env"
    ];
  };
}
