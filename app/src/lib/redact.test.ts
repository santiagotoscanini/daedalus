import { describe, expect, it } from 'vitest'
import { errorText } from './redact'

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
