# The MCP registry — `fleet.mcpServers.<Alias>`.
#
# LiteLLM fronts every MCP server the box offers, so a client presents
# one gateway virtual key and never holds TickTick's personal token or
# Grocy's API key. This file is the single declaration of which servers
# exist; three things derive from it, none maintained by hand:
#
#   - the `mcp_servers:` block of litellm's config.yaml — rendered here
#     as `mcpConfigYaml` and appended by litellm.nix. JSON is valid
#     YAML, so a flow mapping under a block key keeps the whole thing
#     pure string templating with no IFD (same trick as the generated
#     oidc middlewares in stacks/traefik).
#   - the cfweb traefik router, whose rule carries one PathPrefix per
#     published server.
#   - the Cloudflare tunnel CNAME, emitted only when something is
#     actually published.
#
# ── the attr name is the alias is the URL path ─────────────────────────
#
# LiteLLM serves each server at `/<alias>/mcp`, and the union of
# whatever a key may reach at `/mcp/`. Tool names are prefixed
# `<Alias>-<tool>` on BOTH, so the per-server endpoints are a filter,
# not a second namespace — a client can move between them without
# anything that references a tool name breaking.
#
# ── why publication is per-server and opt-in ───────────────────────────
#
# `/mcp/` is deliberately NOT in the generated rule. Publishing the
# union would mean every server declared here becomes reachable from
# the internet the moment it is declared — the box's public surface
# would change with no line of nix saying so. One `exposeRemotely` per
# server keeps that an explicit act, and the default fails closed.
#
# Everything else on the gateway — the admin UI, /login, /v1/*, the
# unauthenticated /reranking pass-through — has no cfweb router at all,
# so traefik 404s it through the tunnel. That is what makes publishing
# the MCP paths safe WITHOUT putting a forward-auth gate on
# litellm.toscanini.me: LAN behaviour is untouched, and Home Assistant
# keeps reaching /v1 on the LAN hostname.
#
# Authentication on the published paths is the LiteLLM virtual key
# (`Authorization: Bearer`), scoped per caller by
# `fleet.litellmKeys.<k>.mcpServers` — which is default-deny, so a key
# reaches no server it was not granted.

{
  config,
  lib,
  ...
}:

let
  cfg = config.fleet.mcpServers;

  exposed = lib.filterAttrs (_: s: s.exposeRemotely) cfg;

  # The gateway's own hostname, read from the webApp rather than
  # restated — the LAN router and this one must agree by construction.
  hostname = config.fleet.webApps.litellm.hostname;

  # LiteLLM's on-disk shape. `alias` and `mcp_info.server_name` are both
  # the attr name: the ledger, the UI and the URL path all key on it, so
  # letting them drift apart would be three names for one server.
  wireShape = name: s: {
    alias = name;
    inherit (s) url transport description;
  }
  // lib.optionalAttrs (s.authType != null) { auth_type = s.authType; }
  // lib.optionalAttrs (s.authValue != null) { auth_value = s.authValue; }
  // {
    mcp_info = {
      server_name = name;
    }
    // lib.optionalAttrs (s.logoUrl != null) { logo_url = s.logoUrl; };
  };

  # The OAuth discovery + flow paths. Published alongside any server so
  # an MCP client that negotiates rather than carrying a static Bearer
  # can complete the handshake. PathPrefix rather than an exact Path:
  # the OpenAPI spec also carries per-server variants
  # (/.well-known/oauth-protected-resource/<server>/mcp) which 404 today
  # because neither server uses upstream OAuth — a prefix keeps working
  # if one ever does. Neither namespace carries a secret; the documents
  # are already served unauthenticated on the LAN.
  oauthPaths = [
    "PathPrefix(`/v1/mcp/oauth`)"
    "PathPrefix(`/.well-known/oauth-protected-resource`)"
    "PathPrefix(`/.well-known/oauth-authorization-server`)"
  ];

  serverPaths = lib.mapAttrsToList (n: _: "PathPrefix(`/${n}/mcp`)") exposed;
in
{
  options.fleet = {
    mcpServers = lib.mkOption {
      default = { };
      description = ''
        MCP servers fronted by the LiteLLM gateway. The attr name is the
        alias LiteLLM registers, the name a virtual key grants in
        `fleet.litellmKeys.<k>.mcpServers`, and the URL path segment
        (`/<Alias>/mcp`) — one string, three uses.

        A stack that runs its own MCP server declares its entry itself
        (see stacks/grocy-mcp); remote SaaS servers, which have no stack,
        are declared below.
      '';
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            url = lib.mkOption {
              type = lib.types.str;
              description = ''
                Where litellm dials the server. A self-hosted one is a
                container DNS name on a bridge litellm shares
                (`http://mcp-grocy:8080/mcp`); a remote one is its public
                HTTPS endpoint.
              '';
              example = "http://mcp-grocy:8080/mcp";
            };
            transport = lib.mkOption {
              type = lib.types.str;
              default = "http";
              description = "MCP transport. Everything here is streamable HTTP.";
            };
            description = lib.mkOption {
              type = lib.types.str;
              description = ''
                Shown to callers listing the gateway's servers. One line,
                naming what the server is for.
              '';
            };
            authType = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = ''
                Upstream auth scheme litellm uses when dialing, e.g.
                "bearer_token". null for a server that needs none
                (a bridge-local one behind its own network isolation).
              '';
            };
            authValue = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = ''
                The upstream credential. Always an `os.environ/VAR`
                reference resolved from litellm's env.sops — never a
                literal, which would land the secret in a world-readable
                /nix/store path.
              '';
              example = "os.environ/TICKTICK_MCP_TOKEN";
            };
            logoUrl = lib.mkOption {
              type = lib.types.nullOr lib.types.str;
              default = null;
              description = "Icon for clients that render a server list.";
            };
            exposeRemotely = lib.mkOption {
              type = lib.types.bool;
              default = false;
              description = ''
                Publish `/<Alias>/mcp` through the Cloudflare tunnel, so
                an off-box MCP client (Claude) can reach it with a scoped
                virtual key. LAN reachability is unconditional and needs
                no flag, exactly as `fleet.webApps.exposeRemotely`.

                Default false: declaring a server must not silently widen
                the box's public surface.
              '';
            };
          };
        }
      );
    };

    mcpConfigYaml = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      default =
        if cfg == { } then
          ""
        else
          "\nmcp_servers: " + builtins.toJSON (lib.mapAttrs wireShape cfg) + "\n";
      description = ''
        Read-only: the `mcp_servers:` block, rendered from
        `fleet.mcpServers` for appending to litellm's config.yaml.
        Consumed by stacks/litellm only — reference it, never restate the
        wire shape.
      '';
    };
  };

  config = {
    # TickTick — the official remote MCP server. No stack of its own (it
    # is SaaS), so it is declared here. litellm holds the static personal
    # API token and injects it upstream, which is the whole point: a
    # gateway client presents its LiteLLM key and never sees this one.
    fleet.mcpServers.TickTick = {
      url = "https://mcp.ticktick.com";
      authType = "bearer_token";
      authValue = "os.environ/TICKTICK_MCP_TOKEN";
      description = "TickTick tasks/lists/habits";
      logoUrl = "https://storage.ghost.io/c/cc/ab/ccab8320-6881-4f00-a181-c9547b33ad7a/content/images/2023/05/TickTick---logo.png";
      exposeRemotely = true;
    };

    # The off-box MCP client's credential. No `consumers`: nothing on
    # this box presents it, so no env file is rendered — the value is
    # read out of the state file once and pasted into the client.
    # Rotate by deleting its line from virtual-keys.env and rebuilding.
    #
    # `models` is narrow on purpose. The published router carries no
    # /v1 path, so this key cannot reach a model through the tunnel at
    # all; the list only bounds what it could do if it were ever used on
    # the LAN, and it keeps gpt-image-2 — the one billed model on the
    # gateway — out of reach.
    # Grants track the published set: a server reachable through the
    # tunnel is one this key may call, so `exposeRemotely` stays the
    # single decision. Pin an explicit list here if a server should ever
    # be published for some other client but not this one.
    fleet.litellmKeys.claude = {
      models = [ "gemma-4-12b" ];
      mcpServers = lib.attrNames exposed;
    };

    # One cfweb router for every published server. Named -mcp so it
    # cannot collide with the generated `litellm.yml` route file (the
    # rules dir is one flat namespace and a raw rule would silently win).
    fleet.traefikRawRules = lib.optionalAttrs (exposed != { }) {
      "litellm-mcp.yml" = builtins.toJSON {
        http = {
          routers.litellm-mcp-cf = {
            entryPoints = [ "cfweb" ];
            rule = "Host(`${hostname}`) && (${lib.concatStringsSep " || " (serverPaths ++ oauthPaths)})";
            service = "litellm-mcp";
          };
          services.litellm-mcp.loadBalancer.servers = [ { url = "http://litellm:4000"; } ];
        };
      };
    };

    # The tunnel CNAME. litellm's webApp is deliberately not
    # `exposeRemotely`, so nothing else emits one for this hostname.
    fleet.cloudflareRoutes = lib.optionalAttrs (exposed != { }) {
      litellm-mcp = { inherit hostname; };
    };

    assertions = [
      {
        assertion = lib.all (s: s.authValue == null || lib.hasPrefix "os.environ/" s.authValue) (
          lib.attrValues cfg
        );
        message = ''
          fleet.mcpServers: `authValue` must be an `os.environ/VAR`
          reference — a literal credential would be rendered into a
          world-readable /nix/store config file.
        '';
      }
    ]
    # A virtual key granting a server that does not exist is the silent
    # failure keys.nix warns about: tools/list answers with an empty
    # array rather than an error, so the caller just loses its tools.
    # With a declared registry that typo is an eval error instead.
    ++ lib.mapAttrsToList (n: k: {
      assertion = lib.all (s: cfg ? ${s}) k.mcpServers;
      message =
        let
          missing = lib.filter (s: !(cfg ? ${s})) k.mcpServers;
        in
        ''
          fleet.litellmKeys.${n}.mcpServers names undeclared MCP
          server(s): ${lib.concatStringsSep ", " missing}. Declare them in
          fleet.mcpServers, or fix the spelling — an unmatched name is
          granted silently and the key simply sees no tools.
        '';
    }) config.fleet.litellmKeys;
  };
}
