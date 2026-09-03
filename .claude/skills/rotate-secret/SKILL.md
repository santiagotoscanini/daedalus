---
name: rotate-secret
description: Rotate a secret end-to-end — sops edit or secrets/-file deletion, rebuild, then restart the exact render units + consumers so the new value actually reaches them. Use for any credential/token/key rotation; a plain rebuild silently serves the old value.
argument-hint: [secret or stack, e.g. "litellm master key" or "traefik CF token"]
---

# /rotate-secret — rotation without the false success

The trap this skill exists for: **a rebuild is not enough.** Activation
prints `modifying secret: …`, `/run/secrets/*` IS the new value — and the
`mkSecretRender` units and every consumer container keep serving the old
one, because nothing restarted them. The most convincing false-success in
the repo. Full mechanics: `.claude/rules/secrets-sops.md`.

## 1. Identify the secret's class and consumers

- **Operator-managed** (`stacks/<x>/*.sops`): edited with sops.
- **Machine-generated** (`stacks/<x>/secrets/<file>`, gitignored): rotated
  by DELETING the file and rebuilding (the bootstrap oneshot mints a new
  value). For litellm virtual keys: delete the one line in
  `stacks/litellm/secrets/virtual-keys.env`.

Find every consumer BEFORE touching anything:

```bash
grep -rn '<secret-name>' /etc/nixos --include='*.nix'
```

Look specifically for `mkSecretRender` blocks reading it — each one is a
render unit + consumer pair that must be restarted by hand.

**Known rotate-together set** (the one duplicated value on the box): the
Cloudflare DNS token lives in `stacks/traefik/env.sops`,
`stacks/cloudflared/env.sops` AND `stacks/daedalus/service-keys.sops` —
rotate all three in one session or lego/tunnel/dashboard drift apart.

**Known render fan-outs** (one source, restart every renderer):
- `stacks/litellm/env.sops` (master key) → `litellm-prom-token` render +
  `daedalus-litellm-key` render → prometheus + app-daedalus consumers.
- `stacks/registry/env.sops` (deploy-hook token) → `daedalus-deploy-hook-token`
  render → app-daedalus.
- `stacks/pocket-id` STATIC_API_KEY → `daedalus-dashboard-keys` render →
  app-daedalus.

## 2. Rotate

Operator-managed: `sops stacks/<x>/env.sops` (as santiago; from inside
/etc/nixos so `.sops.yaml` is found). Editing dotenv in place by CLI needs
`--input-type dotenv --output-type dotenv`. If the operator must supply the
new value (an upstream-issued token), ask for it — never invent one.

Machine-generated: `rm` the file/line (plain rm — this is the sanctioned
rotation-by-deletion flow).

## 3. Rebuild

```bash
git -C /etc/nixos add -A     # sops file changed → new ciphertext must be tracked
sudo nixos-rebuild switch    # sops-nix re-decrypts every activation
```

## 4. Restart the render units AND consumers — the step everyone skips

For EVERY `mkSecretRender` pair found in step 1:

```bash
sudo systemctl restart <render-unit>.service
sudo systemctl restart podman-<consumer>.service
```

Direct consumers (plain `environmentFiles = [ config.sops.secrets… ]`) also
need a container restart — env files are read once at start.

## 5. Verify the new value is live

Never diff secret values in the clear. Verify **behaviorally**, per secret:

- API token: make one authenticated call with the service's own surface
  (e.g. litellm `/models` via a consumer, CF API via ddclient/lego logs).
- SMTP: `systemctl start notify-email@test` or the service's own test mail.
- The old value should now FAIL if the upstream actually revoked it — when
  practical, confirm the revocation took.
- `podman ps` every restarted consumer (green unit ≠ alive container).

## 6. Commit

```bash
git -C /etc/nixos commit -m "<stack>: rotate <secret>"
git -C /etc/nixos push
```

Report: what rotated, which render units + consumers were restarted, and
the behavioral evidence the new value is live.
