import { describe, expect, it } from 'vitest'
import { ceremonyArmed, ceremonyRefusal } from './image-ceremony'

// The gate that stands between "update this pin" and a fifteen-tenant postgres
// bounce. It has two callers now — the Updates panel and the MCP `image.update`
// tool — which is why it is a function rather than a comparison written twice.

describe('a pin with no ceremony', () => {
  it('is armed without anything typed', () => {
    expect(ceremonyArmed('sonarr', null, '')).toBe(true)
    expect(ceremonyArmed('sonarr', null, undefined)).toBe(true)
    expect(ceremonyArmed('sonarr', null, 'anything')).toBe(true)
  })
})

describe('a pin with a ceremony', () => {
  const CEREMONY = 'bounces the shared postgres cluster'

  it('arms only on the exact container name', () => {
    expect(ceremonyArmed('pg', CEREMONY, 'pg')).toBe(true)
    // Surrounding whitespace is a paste, not a different answer.
    expect(ceremonyArmed('pg', CEREMONY, '  pg \n')).toBe(true)
  })

  it('stays closed for anything else', () => {
    for (const typed of [undefined, '', 'p', 'pgx', 'PG', 'yes', 'confirm']) {
      expect(ceremonyArmed('pg', CEREMONY, typed), String(typed)).toBe(false)
    }
  })

  it('never case-folds: a name not read off the row is a name not read', () => {
    // Container names are lowercase by construction, so accepting `PG` would
    // only ever accept a caller that guessed rather than looked.
    expect(ceremonyArmed('pg', CEREMONY, 'PG')).toBe(false)
  })

  it('says what will happen and exactly how to proceed', () => {
    const said = ceremonyRefusal('pg', CEREMONY)
    expect(said).toContain(CEREMONY)
    expect(said).toContain('confirm: "pg"')
  })
})
