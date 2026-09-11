// A replacement Cloudflare API token, before it goes anywhere — the check the
// page runs as it is typed and the server runs again. What happens to it once
// it passes is the vault's (lib/vault.ts, core/vault.ts).
//
// Client-safe: no node imports. The server half is core/settings/cloudflare-token.ts.

import type { VaultFile } from './vault'

/** The vault entry, as apply.sh allowlists it (stacks/daedalus/host/apply.sh). */
export const CLOUDFLARE_TOKEN_FILE = 'vault/cloudflare-api-token.sops' as const satisfies VaultFile
export const CLOUDFLARE_TOKEN_SECRET = 'cloudflare-api-token' as const

/** A token as pasted: one run of token characters, nothing else. */
export function tokenShapeError(value: string): string | null {
  const v = value.trim()
  if (v === '') return 'paste the new token.'
  if (/\s/.test(v)) return 'a token has no spaces or line breaks.'
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(v)) return 'that does not look like a Cloudflare API token.'
  return null
}
