// The site vault — site/vault/, where the secrets set from the UI are kept as
// sops ciphertext (PLAN.md Phase 6). The names apply.sh will write, and the
// last check on what sops produced before it leaves the container.
//
// Client-safe: no node imports. The encrypting half is core/vault.ts.

/**
 * Every vault entry daedalus may seal. apply.sh allowlists what it writes
 * (stacks/daedalus/host/apply.sh MANAGED): the Cloudflare token and the
 * GitHub App's sealed key.
 */
export const VAULT_FILES = ['vault/github-app.sops', 'vault/cloudflare-api-token.sops'] as const

export type VaultFile = (typeof VAULT_FILES)[number]

/**
 * The vault entries sealed as sops JSON rather than binary, and the exact keys
 * each holds. Nix extracts one key per secret (`format = "json"; key = …`), so
 * a key that is missing, renamed or extra is a build that cannot decrypt.
 */
export const VAULT_JSON_KEYS = {
  'vault/github-app.sops': ['pem', 'webhookSecret', 'clientSecret'],
} as const satisfies Partial<Record<VaultFile, readonly string[]>>

export type VaultJsonFile = keyof typeof VAULT_JSON_KEYS

export type VaultJsonValues<F extends VaultJsonFile> = Record<
  (typeof VAULT_JSON_KEYS)[F][number],
  string
>

/** The keys that hold a PEM, which may end with the one newline PEM files end with. */
const PEM_KEYS: ReadonlySet<string> = new Set(['pem'])

/**
 * Why `values` cannot be sealed for `file`, or null when they can: every key
 * the file declares must be a non-empty string with no surrounding whitespace,
 * except that a PEM may end with a single `\n`. Keys the file does not declare
 * are not looked at — they are never sealed. The reason names the key, never
 * the value.
 */
export function jsonVaultValuesError(file: VaultJsonFile, values: unknown): string | null {
  const keys: readonly string[] | undefined = VAULT_JSON_KEYS[file]
  if (keys === undefined) return 'the file is not a JSON vault entry'
  if (values === null || typeof values !== 'object') return 'no values were given'
  const plain = values as Record<string, unknown>
  for (const key of keys) {
    const v = plain[key]
    if (typeof v !== 'string') return `the ${key} is not a string`
    if (v === '') return `the ${key} is empty`
    const core = PEM_KEYS.has(key) && v.endsWith('\n') ? v.slice(0, -1) : v
    if (core === '' || core !== core.trim()) return `the ${key} starts or ends with whitespace`
  }
  return null
}

type SopsMeta = { age?: unknown; mac?: unknown }

function metadataError(sops: SopsMeta | undefined): string | null {
  if (!Array.isArray(sops?.age) || sops.age.length === 0) return 'the file names no age recipient'
  if (typeof sops?.mac !== 'string' || !sops.mac.startsWith('ENC[')) return 'the file has no MAC'
  return null
}

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
  const d = doc as { data?: unknown; sops?: SopsMeta } | null
  if (d === null || typeof d !== 'object') return 'sops did not produce a sops file'
  if (typeof d.data !== 'string' || !d.data.startsWith('ENC[')) return 'the value is not encrypted'
  return metadataError(d.sops)
}

/** Shorter PEM body lines are not needles: they could turn up inside ciphertext by chance. */
const PEM_LINE_MIN = 16

/**
 * The strings whose presence in sops output means a value leaked: each value,
 * its JSON-escaped form, and for a PEM every base64 body line of 16 or more
 * characters — JSON escapes the newlines, so a PEM copied into the output
 * verbatim never matches as a whole, and any one line of it is still the key.
 * Sixteen base64 characters are 96 bits; a shorter last line is left out.
 */
function leakNeedles(value: string): string[] {
  if (value === '') return []
  const needles = [value, JSON.stringify(value).slice(1, -1)]
  if (value.includes('-----BEGIN')) {
    for (const raw of value.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.length >= PEM_LINE_MIN && !line.startsWith('-----')) needles.push(line)
    }
  }
  return needles
}

/**
 * Every string in a parsed document, keys included. JSON.parse has undone the
 * escaping, so a value spelled out in `\u` escapes — invisible to a search of
 * the raw output — is plain here. Iterative: the document's depth is sops's
 * to choose.
 */
function stringsIn(doc: unknown): string[] {
  const found: string[] = []
  const stack: unknown[] = [doc]
  while (stack.length > 0) {
    const v = stack.pop()
    if (typeof v === 'string') found.push(v)
    else if (Array.isArray(v)) for (const item of v) stack.push(item)
    else if (v !== null && typeof v === 'object') {
      for (const [key, item] of Object.entries(v)) {
        found.push(key)
        stack.push(item)
      }
    }
  }
  return found
}

const LEAKED = 'the output contains a value itself'

/**
 * Why `out` is not the sops JSON file for `file` sealing `values`, or null
 * when it is: exactly the file's keys plus `sops`, each an encrypted string,
 * an age recipient, a MAC — and none of the values anywhere in it, searched
 * both in the raw output and in every string of the parsed document.
 */
export function jsonCiphertextError<F extends VaultJsonFile>(
  file: F,
  out: string,
  values: VaultJsonValues<F>,
): string | null {
  const plain: Record<string, unknown> = values
  const expected: readonly string[] = VAULT_JSON_KEYS[file]
  const needles = expected.flatMap((key) => {
    const v = plain[key]
    return typeof v === 'string' ? leakNeedles(v) : []
  })
  if (needles.some((n) => out.includes(n))) return LEAKED
  let doc: unknown
  try {
    doc = JSON.parse(out)
  } catch {
    return 'sops did not produce a sops file'
  }
  if (stringsIn(doc).some((s) => needles.some((n) => s.includes(n)))) return LEAKED
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return 'sops did not produce a sops file'
  }
  const d = doc as Record<string, unknown>
  for (const key of expected) {
    if (!(key in d)) return `the file has no ${key}`
  }
  for (const key of Object.keys(d)) {
    if (key !== 'sops' && !expected.includes(key)) return 'the file carries an unexpected key'
  }
  for (const key of expected) {
    const v = d[key]
    if (typeof v !== 'string' || !v.startsWith('ENC[') || !v.includes('type:str]')) {
      return `the ${key} is not encrypted`
    }
  }
  return metadataError(d.sops as SopsMeta | undefined)
}
