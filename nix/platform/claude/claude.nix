# Claude Code's project config lives in the configuration repo, so a fresh
# checkout carries the operator manual (AGENTS.md), the slash commands and
# skills (.claude/) and the MCP wiring — not just the system.
#
# `.mcp.json` names an MCP server plus the bearer token that reaches it, so
# it is never tracked in the clear. It is RENDERED at activation
# (claude-mcp-json.service, assets/mcp-json.sh) from two halves:
#
#   - the operator's encrypted file (`fleet.claude.mcpSopsFile`), decrypted
#     by sops-nix to /run/secrets/claude-mcp-json — the HOST's file: an
#     engine has no `.claude/` of the box's to reach into;
#   - the servers stacks declare (`fleet.claude.mcpServers`): an HTTP
#     endpoint plus the file the box keeps its bearer in — a gateway's
#     virtual key, minted on the box. An entry there replaces a server of
#     the same name in the encrypted file.
#
# The result lives on tmpfs (/run/claude-mcp/mcp.json) and the checkout's
# `.mcp.json` is a symlink to it, which the render makes: tmpfiles refuses
# to write under a directory the operator owns.
#
# The render re-runs when the ciphertext or the declared servers change
# (restartTriggers), so a sops edit plus a rebuild lands. A bearer rotated in
# its own file does not move the unit: `systemctl restart claude-mcp-json`
# after one. Claude Code reads the file when a session starts.
#
# Unset `mcpSopsFile`: this module does nothing.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fleet.claude;
  # Names, URLs and where each bearer lives — no secret is in it.
  servers = pkgs.writeText "claude-mcp-servers.json" (
    builtins.toJSON (lib.mapAttrs (_: s: { inherit (s) url bearerFile bearerVar; }) cfg.mcpServers)
  );
  writers = lib.unique (lib.concatMap (s: s.after) (lib.attrValues cfg.mcpServers));
  render = pkgs.writeShellApplication {
    name = "claude-mcp-json";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.jq
    ];
    text = ''
      SECRET=${lib.escapeShellArg config.sops.secrets."claude-mcp-json".path}
      SERVERS=${servers}
      OUT=/run/claude-mcp/mcp.json
      LINK=${lib.escapeShellArg "${config.fleet.config.repo}/.mcp.json"}
      ${builtins.readFile ./assets/mcp-json.sh}
    '';
  };
in
{
  options.fleet.claude = {
    mcpSopsFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = lib.literalExpression "./.claude/mcp.json.sops";
      description = ''
        The sops-encrypted (binary format) source of the checkout's
        `.mcp.json`, rendered at activation to `''${fleet.config.repo}/.mcp.json`
        for the operator together with `mcpServers`. Null: no `.mcp.json` is
        materialized.
      '';
    };

    mcpServers = lib.mkOption {
      default = { };
      description = ''
        MCP servers put into the rendered `.mcp.json` beside the encrypted
        file's, each an HTTP endpoint reached with a bearer the box keeps in
        a file of its own (a gateway's virtual key, say), so the bearer is
        never copied into the operator's file. The attr name is the server's
        name in `.mcp.json`, and replaces a server of that name there.
      '';
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            url = lib.mkOption {
              type = lib.types.str;
              example = "https://gateway.example.org/Tools/mcp";
              description = "The server's streamable-HTTP endpoint.";
            };
            bearerFile = lib.mkOption {
              type = lib.types.str;
              example = "/var/lib/gateway/keys.env";
              description = "A file of `VAR=value` lines holding the bearer, readable by the operator.";
            };
            bearerVar = lib.mkOption {
              type = lib.types.str;
              example = "GATEWAY_KEY";
              description = "The variable in `bearerFile` whose value is the bearer.";
            };
            after = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              example = [ "gateway-keys.service" ];
              description = "Units that write `bearerFile`; the render runs after them.";
            };
          };
        }
      );
    };
  };

  config = lib.mkIf (cfg.mcpSopsFile != null) {
    sops.secrets."claude-mcp-json" = {
      sopsFile = cfg.mcpSopsFile;
      format = "binary";
      owner = config.fleet.operator.user;
      mode = "0400";
    };

    systemd.services.claude-mcp-json = {
      description = "Render the operator's .mcp.json";
      wantedBy = [ "multi-user.target" ];
      after = writers;
      wants = writers;
      restartTriggers = [
        cfg.mcpSopsFile
        servers
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = config.fleet.operator.user;
        Group = config.fleet.operator.group;
        RuntimeDirectory = "claude-mcp";
        RuntimeDirectoryMode = "0700";
        RuntimeDirectoryPreserve = "yes";
        ExecStart = lib.getExe render;
        Restart = "on-failure";
        RestartSec = "10s";
      };
    };
  };
}
