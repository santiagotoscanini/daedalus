# Secrets

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
