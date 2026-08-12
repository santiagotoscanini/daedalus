# Adding a stack

A stack is one self-hosted service: a folder under `stacks/` holding
its module, its tracked assets, and its encrypted secrets. No import
line anywhere — `configuration.nix` auto-imports every `*.nix` under
`stacks/`.

```bash
# the repo is santiago-owned — no sudo for file/git operations (root-made
# .git objects break santiago's push; only nixos-rebuild needs root)
mkdir -p /etc/nixos/stacks/<name>/assets
$EDITOR /etc/nixos/stacks/<name>/<name>.nix      # see any stack as template
# secrets, if any:
#   printf 'KEY=value\n' | sops -e --input-type dotenv --output-type dotenv \
#     /dev/stdin > /etc/nixos/stacks/<name>/env.sops
#   then in the module:  sops.secrets."<name>-env" = mkDotenvSecret ./env.sops;
#   and:  environmentFiles = [ config.sops.secrets."<name>-env".path ];
# the flake only sees git-tracked files, so `git add` first
git -C /etc/nixos add -A && sudo nixos-rebuild test && sudo nixos-rebuild switch
git -C /etc/nixos commit -am "<name>: add stack"
```

The module template and its variants (multi-bridge, multi-port,
host-port) live in `.claude/rules/module-system.md`, alongside the full
reference for the `fleet.*` options a stack contributes to.

Apps built for the platform don't need any of this — Daedalus's own
Apps pages create the registry entry, run the first CI build, and
apply it.
