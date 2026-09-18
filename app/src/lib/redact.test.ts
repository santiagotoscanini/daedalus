import { describe, expect, it } from 'vitest'
import { errorText, redactSecrets } from './redact'

// `redactSecrets` is exercised in builds.test.ts, where the secret-shaped
// fixtures live. What is pinned here is the part `errorText` adds, because it
// is the part that used to be missing: ~21 hand-copied `e instanceof Error ?
// e.message : String(e)` expressions rendered a caught message straight into
// the DOM, and only the build scheduler's copy redacted or capped it.

// Assembled at runtime so the source never carries a string a secret scanner
// would flag, the same way builds.test.ts does it.
const TOKEN = `ghs${'_'}${'A1b2C3d4'.repeat(5)}`

describe('errorText', () => {
  it('is the message, for the ordinary case', () => {
    expect(errorText(new Error('no app named iris'))).toBe('no app named iris')
  })

  it('names a non-Error rather than rendering nothing', () => {
    expect(errorText('a thrown string')).toBe('a thrown string')
    expect(errorText(null)).toBe('null')
  })

  it('redacts a credential a subprocess or a remote put in the message', () => {
    const out = errorText(new Error(`remote: https://x-access-token:${TOKEN}@github.com/o/r.git`))
    expect(out).not.toContain(TOKEN)
    expect(out).toContain('[redacted]')
  })

  it('keeps the first line and caps the length, so a log dump cannot become the page', () => {
    expect(errorText(new Error(`the sentence\n${'x'.repeat(5_000)}`))).toBe('the sentence')
    expect(errorText(new Error('y'.repeat(5_000)))).toHaveLength(300)
  })
})

// ── the app-secrets editor's shapes ───────────────────────────────────────
//
// The write-only secrets editor adds three kinds of text that pass through a
// log or a status file, and each is here for a different reason.
//
// The sealed value and the agent's own sentences must survive VERBATIM: they
// are what the operator reads, and a redactor that mangled them would look
// exactly like a leak being caught. The token line is the opposite check —
// nothing about this verb is meant to put a credential into a message, so the
// assertion is that the net still holds if one ever did.
describe('redactSecrets, over the secret-set verb', () => {
  const SEALED =
    '{"data":"ENC[AES256_GCM,data:rkwF2XLwiSgc5jyOBG4F,iv:WzXN0zGqCARZ,tag:Cu0rsprB4IWR,type:str]",' +
    '"sops":{"age":[{"recipient":"age13xjamkkjcc2wdan3c8tscslqulgwz9uv"}],"mac":"ENC[AES256_GCM,data:z]"}}'

  it('leaves a sops document alone — ciphertext is not a credential', () => {
    // This is the whole body of a secret-set request, and the bridge log holds
    // it. Redacting it would destroy the only copy of a value nobody can
    // retype, for no gain: it is already unreadable without the host's key.
    expect(redactSecrets(SEALED)).toBe(SEALED)
  })

  it('leaves the agent’s own sentences alone — they name keys, never values', () => {
    for (const line of [
      'secret-set: sealed INVITE_CODE into vault/apps/hermes-env.sops, committed 1a2b3c4',
      'secret-set: removed OIDC_EMAILS from vault/apps/hermes-env.sops, committed 1a2b3c4',
      'secrets: hermes set INVITE_CODE',
      "secret-set request rejected: 'HAS-HYPHEN' is not an environment variable name",
      "secret-set request rejected: no app named 'ghost' in the applied registry",
    ]) {
      expect(redactSecrets(line)).toBe(line)
    }
  })

  it('still redacts a credential if one ever reached one of those messages', () => {
    const out = redactSecrets(`secret-set agent failure: sops said token=${TOKEN}`)
    expect(out).not.toContain(TOKEN)
    expect(out).toContain('[redacted]')
  })
})
