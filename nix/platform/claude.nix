# Claude Code's project config lives in the configuration repo, so a fresh
# checkout carries the operator manual (CLAUDE.md), the slash commands and
# skills (.claude/) and the MCP wiring — not just the system.
#
# `.mcp.json` names an MCP server plus the bearer token that reaches it,
# so the tracked copy is sops-encrypted and materialized at activation.
# Unlike a mkSecretRender oneshot, sops-nix re-decrypts on EVERY
# activation, so editing the sops file and rebuilding actually lands the
# new value — see CLAUDE.md, "a rotated secret does not reach the box".
#
# The rendered path is gitignored; the ciphertext is the tracked source —
# and it is the HOST's file (`fleet.claude.mcpSopsFile`): an engine has no
# `.claude/` of the box's to reach into. Unset, this module does nothing.
{ config, lib, ... }:

let
  cfg = config.fleet.claude;
in
{
  options.fleet.claude.mcpSopsFile = lib.mkOption {
    type = lib.types.nullOr lib.types.path;
    default = null;
    example = lib.literalExpression "./.claude/mcp.json.sops";
    description = ''
      The sops-encrypted (binary format) source of the checkout's `.mcp.json`,
      decrypted at activation to `''${fleet.config.repo}/.mcp.json` for the
      operator. Null: no `.mcp.json` is materialized.
    '';
  };

  config = lib.mkIf (cfg.mcpSopsFile != null) {
    sops.secrets."claude-mcp-json" = {
      sopsFile = cfg.mcpSopsFile;
      format = "binary";
      owner = config.fleet.operator.user;
      mode = "0400";
      path = "${config.fleet.config.repo}/.mcp.json";
    };
  };
}
