# The secrets this host hands the engine

Every file here is a **placeholder** in the template — the engine's CI
evaluates the template, and sops-nix only takes a path at evaluation. Before
the first switch, replace each with real ciphertext:

1. Write `.sops.yaml` at the repository root with two recipients: the box
   (`ssh-to-age < /etc/ssh/ssh_host_ed25519_key.pub`) so it decrypts at
   activation, and your own age key so a clone anywhere plus that key is
   the whole recovery path.
2. Create each file with `sops` in the format its reader expects:

   | File | Format | Contents |
   |---|---|---|
   | `git-ssh-key.sops` | binary | the private SSH key the box pushes with |
   | `smtp-password.sops` | binary | the relay account's password, nothing else |
   | `service-keys.sops` | dotenv | `DASH_<SERVICE>=<key>` per service; may be empty |
   | `traefik/env.sops` | dotenv | `POCKET_OIDC_COOKIE_SECRET=<32+ random bytes>` |
   | `pocket-id/env.sops` | dotenv | `ENCRYPTION_KEY=<random>` (fixed once set) |
   | `registry/env.sops` | dotenv | `REGISTRY_PROM_PASSWORD=…`, `DEPLOY_HOOK_TOKEN=…` |
   | `monitoring/env.sops` | dotenv | `GF_SECURITY_ADMIN_USER=…`, `GF_SECURITY_ADMIN_PASSWORD=…` |
   | `healthchecks/env.sops` | dotenv | `SECRET_KEY=<random>` |
   | `cloudflared/credentials.json.sops` | binary | the tunnel's credentials JSON, shown once at creation |

   A dotenv: `sops -e --input-type dotenv --output-type dotenv plain.env > <file>.sops`;
   binary: `sops -e --input-type binary --output-type binary plain > <file>.sops`.
   Never commit the plaintext.

The site's own vault (`site/vault/cloudflare-api-token.sops`, the Cloudflare
API token) is created the same way and rotated from the control plane's
Settings › Integrations afterwards.
