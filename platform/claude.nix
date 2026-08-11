# Claude Code's project config lives in this repo, so a fresh checkout
# carries the operator manual (CLAUDE.md), the slash commands and skills
# (.claude/) and the MCP wiring — not just the system.
#
# `.mcp.json` names an MCP server plus the bearer token that reaches it,
# so the tracked copy is sops-encrypted and materialized at activation.
# Unlike a mkSecretRender oneshot, sops-nix re-decrypts on EVERY
# activation, so editing the sops file and rebuilding actually lands the
# new value — see CLAUDE.md, "a rotated secret does not reach the box".
#
# The rendered path is gitignored; the ciphertext is the tracked source.
{
  sops.secrets."claude-mcp-json" = {
    sopsFile = ../.claude/mcp.json.sops;
    format = "binary";
    owner = "santiago";
    mode = "0400";
    path = "/etc/nixos/.mcp.json";
  };
}
