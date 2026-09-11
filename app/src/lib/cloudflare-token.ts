// A replacement Cloudflare API token, before it goes anywhere — the checks
// the page runs as it is typed and the server runs again, and the last check
// on what sops produced before it leaves the container.
//
// Client-safe: no node imports. The server half is core/settings/cloudflare-token.ts.

/** The vault entry, as apply.sh allowlists it (stacks/daedalus/host/apply.sh). */
export const CLOUDFLARE_TOKEN_FILE = 'vault/cloudflare-api-token.sops' as const
export const CLOUDFLARE_TOKEN_SECRET = 'cloudflare-api-token' as const

/** A token as pasted: one run of token characters, nothing else. */
export function tokenShapeError(value: string): string | null {
  const v = value.trim()
  if (v === '') return 'paste the new token.'
  if (/\s/.test(v)) return 'a token has no spaces or line breaks.'
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(v)) return 'that does not look like a Cloudflare API token.'
  return null
}

/**
 * Why `out` is not a sops file for a binary secret, or null when it is.
 *
 * sops exits 0 on more than success — an early build of this very flow
 * captured its usage text as the "ciphertext" — so the output is checked for
 * the shape of a real one: an encrypted `data`, at least one age recipient, a
 * MAC. And it must not contain the value, whatever else it is.
 */
export function ciphertextError(out: string, plaintext: string): string | null {
  if (plaintext !== '' && out.includes(plaintext)) return 'the output contains the token itself'
  let doc: unknown
  try {
    doc = JSON.parse(out)
  } catch {
    return 'sops did not produce a sops file'
  }
  const d = doc as { data?: unknown; sops?: { age?: unknown; mac?: unknown } } | null
  if (d === null || typeof d !== 'object') return 'sops did not produce a sops file'
  if (typeof d.data !== 'string' || !d.data.startsWith('ENC[')) return 'the value is not encrypted'
  if (!Array.isArray(d.sops?.age) || d.sops.age.length === 0)
    return 'the file names no age recipient'
  if (typeof d.sops?.mac !== 'string' || !d.sops.mac.startsWith('ENC['))
    return 'the file has no MAC'
  return null
}
