// The site vault — site/vault/, where the secrets set from the UI are kept as
// sops ciphertext (PLAN.md Phase 6). The names apply.sh will write, and the
// last check on what sops produced before it leaves the container.
//
// Client-safe: no node imports. The encrypting half is core/vault.ts.

/** Every vault entry, exactly as apply.sh allowlists them (stacks/daedalus/host/apply.sh MANAGED). */
export const VAULT_FILES = ['vault/cloudflare-api-token.sops', 'vault/github-token.sops'] as const

export type VaultFile = (typeof VAULT_FILES)[number]

/**
 * Why `out` is not a sops file for a binary secret, or null when it is.
 *
 * sops exits 0 on more than success — an early build of the Cloudflare flow
 * captured its usage text as the "ciphertext" — so the output is checked for
 * the shape of a real one: an encrypted `data`, at least one age recipient, a
 * MAC. And it must not contain the value, whatever else it is.
 */
export function ciphertextError(out: string, plaintext: string): string | null {
  if (plaintext !== '' && out.includes(plaintext)) return 'the output contains the value itself'
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
