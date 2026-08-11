# s2-server

NixOS home server. **This repo is the complete system definition**:
`flake.lock` pins every input, secrets are sops-encrypted in-tree, and
any checkout + a decryption key rebuilds the exact running system.

Deeper operational docs live in each module's header comment (per-stack
quirks — always the canonical source for a stack) and in these
repo-level docs:

| File | What it holds |
|---|---|
| `CLAUDE.md` | Operator notes: hard rules, the `fleet.*` module system, cross-cutting gotchas, debugging protocol, and the decisions that are settled and should not be re-proposed. |
| `AUTH.md` | The per-service SSO migration plan. |
| `FUTURE.md` | Deferred work and open follow-ups. |
| `HARDWARE.md` | Dated physical-layer event log (journald keeps only ~11 days). |
| `lemonade.md` | The GPU box's model server and its REST API. |

Claude Code's project config is in-tree too — `.claude/` (skills,
commands, tracked settings) plus `.claude/mcp.json.sops`, which
`platform/claude.nix` decrypts to `.mcp.json` at activation. So a fresh
checkout carries the operator manual and tooling, not just the system.

## Daily driver commands

```bash
sudo nixos-rebuild test      # try the config without committing to it
sudo nixos-rebuild switch    # commit as the next boot generation
```

Both auto-detect `flake.nix` — no flags needed. The flake only sees
**git-tracked files**: `sudo git add <newfile>` before rebuilding, or
the eval fails with "file not found".

## Upgrades

```bash
cd /etc/nixos
nix flake update             # as santiago — the repo is santiago-owned;
                             # sudo would leave root-owned .git objects
sudo nixos-rebuild test      # verify
sudo nixos-rebuild switch
git add flake.lock && git commit -m "flake.lock: update" && git push
```

`flake-autoupgrade.timer` does all of this weekly — lock update, commit,
`nixos-rebuild boot` (staged for next boot, never auto-reboots), AND the
push to origin. Roll back an upgrade with `git revert` on the lock
commit + rebuild, or pick an older generation from the boot menu.

Container images are pinned per-stack; updating one is
`podman pull` + `systemctl restart podman-<name>` (moving tags) or a
tag edit + rebuild (pinned tags).

## Secrets

Two classes — know which one you're touching:

| Class | Where | Edit / rotate |
|---|---|---|
| Operator secrets (API tokens, admin creds, VPN keys) | `*.sops` files, encrypted, **tracked in git** | `sops <file>` opens $EDITOR, re-encrypts on save; rebuild to apply |
| Machine-generated (app-db passwords, per-app AUTH_SECRET) | `stacks/{apps,app-db}/secrets/` — plaintext, **gitignored** | delete the file + rebuild; the bootstrap oneshot re-rolls it |

sops recipients are in `.sops.yaml`: the host (key derived from its SSH
host key at activation — nothing to manage) and santiago's personal age
key (`~/.config/sops/age/keys.txt`, **copy in the password manager**).
Decrypted material lands in `/run/secrets/` (tmpfs) at activation.

Conventions: encrypted files end in `.sops` at the stack root; dotenv
for env files, binary for everything else. `sops <file>` needs an
identity: as santiago it Just Works (keys.txt); as root prefix with
`SOPS_AGE_KEY_FILE=/home/santiago/.config/sops/age/keys.txt`.

Special case: the LiteLLM master key has one encrypted source
(`stacks/litellm/env.sops`); its other consumers — the prometheus
bearer token and daedalus's `LITELLM_API_KEY` — are rendered from it
at boot, so rotation touches that one file. The Cloudflare DNS token is
the opposite: the same value lives in traefik's and cloudflared's
env.sops and in daedalus's service-keys.sops — rotate all three
together.

## Adding a stack

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
# no import line needed — configuration.nix auto-imports every *.nix
# under stacks/ (the flake only sees git-tracked files, so `git add` first)
git -C /etc/nixos add -A && sudo nixos-rebuild test && sudo nixos-rebuild switch
git -C /etc/nixos commit -am "<name>: add stack"
```

## Disaster recovery

1. Fresh NixOS install (any version with flakes) on new hardware.
2. `git clone git@github.com:santiagotoscanini/nixos-s2.git /etc/nixos`
3. Restore the decryption identity — either the old host SSH key to
   `/etc/ssh/ssh_host_ed25519_key`, or santiago's age key (password
   manager) to `~/.config/sops/age/keys.txt` + re-encrypt for the new
   host key: `sops updatekeys` after adding it to `.sops.yaml`.
4. `sudo nixos-rebuild switch --flake /etc/nixos#s2-server`
5. Data: `zpool import` both pools; machine-generated secrets and app
   data restore from ZFS snapshots / `/s2/shared/` backups. The
   bootstrap oneshots re-roll anything missing (new DB passwords —
   apps reconnect via the regenerated env files).

What is NOT in this repo: ZFS pool contents (`/s2/*`, app data under
`/home/santiago/selfhost/`), pi-hole's gravity.db, `acme.json`
(re-issues automatically; LE rate-limits apply), the machine-generated
`secrets/` dirs, and grafana's own DB state (UI users/service accounts
— on the shared app-db cluster, covered by its backup story).
