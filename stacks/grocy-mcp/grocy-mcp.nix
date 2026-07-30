# grocy-mcp — miguelangel-nubla/mcp-grocy: a streamable-HTTP MCP server
# fronting Grocy's REST API. Rides the LiteLLM MCP gateway like the other
# MCP servers: litellm dials http://mcp-grocy:8080/mcp over the private
# grocy-mcp bridge (only litellm + this server are on it).
#
# Reaches Grocy the way the homepage widget does — through traefik at
# https://grocy.toscanini.me/api, which is SSO-bypassed (grocy's
# authBypassRule = PathPrefix(`/api`)) and authenticated by the
# GROCY-API-KEY header. That key lives here in env.sops, held by the MCP
# server, so gateway clients only ever present their LiteLLM key.
#
# The tool set is curated in assets/mcp-grocy.yaml (most of the ~55 tools
# disabled) so gemma-4-12b isn't swamped. Stateless — no bind mount for
# data; the read-only config is the only volume.

{
  config,
  mkRootlessContainer,
  mkDotenvSecret,
  ...
}:
{
  # Private bridge: only litellm + this server. litellm's list merges
  # with its own [ "app-db" "traefik" ] contribution.
  fleet.bridgeMemberships = {
    "mcp-grocy" = [ "grocy-mcp" ];
    litellm = [ "grocy-mcp" ];
  };

  fleet.logStacks."grocy-mcp" = [ "mcp-grocy" ];

  # GROCY_API_KEY — operator-managed (Grocy -> Settings -> Manage API keys).
  sops.secrets."grocy-mcp-env" = mkDotenvSecret ./env.sops;

  virtualisation.oci-containers.containers.mcp-grocy = mkRootlessContainer {
    image = "ghcr.io/miguelangel-nubla/mcp-grocy:v2.6.0@sha256:c4de8d1afcd19d4501e1fedef2321f042e0589ca305e535d8a9945ae091af969";

    volumes = [
      "${./assets/mcp-grocy.yaml}:/app/mcp-grocy.yaml:ro"
    ];

    environment = {
      GROCY_BASE_URL = "https://grocy.toscanini.me";
      GROCY_ENABLE_SSL_VERIFY = "true";
      # Daemon mode: HTTP transport only (no stdio client attached).
      ENABLE_HTTP_SERVER = "true";
      MCP_HTTP_TRANSPORT_ONLY = "true";
      HTTP_SERVER_PORT = "8080";
      # Every line this writes goes to stderr, so journald tags its
      # routine INFO chatter as err-priority and it shows up in any
      # warning-level sweep. Only warnings and worse are wanted.
      LOG_LEVEL = "WARN";
    };

    environmentFiles = [ config.sops.secrets."grocy-mcp-env".path ];
  };
}
