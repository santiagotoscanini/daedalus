---
paths:
  - "**/*.sops"
  - ".sops.yaml"
  - "platform/sops.nix"
---

# Secrets — sops-nix mechanics

Managed by **sops-nix** (age encryption). Two classes — never conflate
them (the split is summarized in CLAUDE.md; this file is the working
detail).

## Operator-managed — `*.sops`, encrypted, tracked in git

Encrypted files (dotenv or binary) live at the **stack root**, end in
`.sops`, and decrypt at activation to `/run/secrets/<name>` (tmpfs,
never on disk) with the owner/mode set by `sops.secrets.<name>`.
Recipients (`.sops.yaml`): the **host key** (`ssh-to-age` of
`/etc/ssh/ssh_host_ed25519_key`) and **santiago's personal age key**
(`~/.config/sops/age/keys.txt` + password manager, the recovery path).

```nix
# in a stack module:
sops.secrets."<stack>-env" = {
  sopsFile = ./env.sops;
  format   = "dotenv";       # or "binary" for keys/certs/wg0.conf
  key      = "";             # whole file; a dotenv key name extracts one var
  owner    = "santiago";     # rootless podman reads it pre-userns-remap
};
# ...
environmentFiles = [ config.sops.secrets."<stack>-env".path ];
```

(`mkDotenvSecret ./env.sops` from `_module.args` is the boilerplate
for the dotenv case.)

- **Edit:** `sops stacks/<stack>/env.sops` (decrypts to `$EDITOR`,
  re-encrypts on save). Then `nixos-rebuild switch`.
- **⚠ Rebuilding is not enough if a `mkSecretRender` unit reads that
  secret.** The rebuild updates `/run/secrets/*` but the render unit
  and its consumer both keep serving the old value — restart both by
  hand (`/rotate-secret` walks this). The most convincing
  false-success in the repo.
- **Add a recipient / rotate the host key:** edit `.sops.yaml`, then
  `sops updatekeys` every `*.sops` file **before** destroying the old
  key.
- **`sops` needs an identity** when run by hand, and is not on PATH:
  `SOPS_AGE_KEY_FILE=~santiago/.config/sops/age/keys.txt nix run nixpkgs#sops -- -d …`
  (or run as santiago). Root has no default age key. Editing a `.sops`
  dotenv in place needs `--input-type dotenv --output-type dotenv` —
  the name isn't `.env`, so auto-detect assumes JSON.
- **`.sops.yaml` is one catch-all rule**, so a new `*.sops` anywhere in
  the repo gets both recipients with no config change. Encrypt from
  inside `/etc/nixos` (or pass `--config`) or the rule isn't found and
  the host key is missing — activation then can't decrypt.

Encrypted `*.sops` files are `0644` (ciphertext — safe to commit and
world-read). Never commit plaintext; `**/secrets/` stays gitignored as
the safety net.

## The dedup principle — nothing exists twice

- **litellm master key**: one encrypted source
  (`stacks/litellm/env.sops`). Every other consumer — the prometheus
  bearer token (`litellm-prom-token`), daedalus's `LITELLM_API_KEY` —
  is a `mkSecretRender` boot oneshot reading it; rotation touches only
  env.sops.
- **Cloudflare DNS token** is the one remaining rotate-together set:
  the same value lives in traefik's and cloudflared's env.sops and in
  `stacks/daedalus/service-keys.sops`.
- **Per-service read-only API keys** (Jellyfin token, *arr keys, CF
  token — what daedalus reads numbers with) live together in
  `stacks/daedalus/service-keys.sops`, rendered as `DASH_<n>`. One is
  deliberately NOT duplicated there: pocket-id's `STATIC_API_KEY` is
  grepped out of its own stack's secret.
- **Argus's operator secrets** (index API key + peppers) live in tracked
  `stacks/apps/argus-env.sops`; the machine-generated
  `stacks/apps/secrets/argus/env` carries only `AUTH_SECRET`.

## `mkSecretRender` — derived secrets, and its two silent traps

When an image wants a secret under a different name, do NOT re-export
in an entrypoint wrapper — render a derived file with `mkSecretRender`
(one sops source; a boot oneshot writes the shape the consumer wants).
Fifteen stacks use it; representative cases: litellm's prometheus
bearer token, n8n + healthchecks SMTP env, nextcloud-redis's
redis.conf. For DB passwords from the shared cluster neither is needed
— the generated env file already carries POSTGRES_PASSWORD and
DB_POSTGRESDB_PASSWORD; a further alias goes in
`stacks/app-db/assets/bootstrap.sh`.

1. **Never render into `/run/<container-name>`** — that's the unit's
   `RuntimeDirectory` (Preserve=no): systemd deletes it every time the
   container stops, the RemainAfterExit render unit doesn't re-run,
   and the consumer crash-loops on a missing file (hours of Nextcloud
   500s). Pick a dir whose basename matches no container:
   `/run/nextcloud-redis-conf`, not `/run/nextcloud-redis`.
2. **A rotated secret does not reach the box on a rebuild.** New
   ciphertext doesn't change the render unit's text, so nothing
   restarts — and the consumer read the old file at start anyway.
   After any rotation:
   `sudo systemctl restart <render>.service && sudo systemctl restart podman-<consumer>.service`.
   Plain `sops.secrets.<n>` are immune — sops-nix re-decrypts every
   activation (why `platform/claude.nix` uses one directly).

## Machine-generated — `**/secrets/`, gitignored, NOT in sops

Born on the box by bootstrap oneshots; rotate by deleting the file +
rebuild. Durability is a **backup** concern, not git.

| Path | Owner | Used by |
|---|---|---|
| `stacks/app-db/secrets/cluster/env` + `<name>/env` | `santiago:users` | shared pg cluster + per-app DATABASE_URL |
| `stacks/apps/secrets/<name>/env` | `santiago:users` | per-app `AUTH_SECRET` |
| `stacks/litellm/secrets/virtual-keys.env` | `santiago:users` | LiteLLM virtual keys (rotate by deleting the line) |

The GHCR fallback authfile is operator-managed sops
(`stacks/apps/ghcr-auth.json.sops`), not machine-generated — and inert
while every app pulls from the box's own registry.
