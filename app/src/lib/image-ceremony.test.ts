import { describe, expect, it } from 'vitest'
import { ceremonyArmed, ceremonyFor, ceremonyRefusal } from './image-ceremony'

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

describe('a pin whose ceremony is for a new major only', () => {
  const MAJOR = 'needs its upgrade chores run by hand'
  const pin = { tag: '34', ceremony: null, majorCeremony: MAJOR }

  it('owes it for a move that changes the leading version number', () => {
    expect(ceremonyFor(pin, '35')).toBe(MAJOR)
    expect(ceremonyFor({ ...pin, tag: 'v2.9.1' }, 'v3.0.0')).toBe(MAJOR)
  })

  it('owes nothing for a re-pull or a move on the same major', () => {
    expect(ceremonyFor(pin, undefined)).toBe(null)
    expect(ceremonyFor(pin, '34')).toBe(null)
    expect(ceremonyFor({ ...pin, tag: '2026.7.4' }, '2026.9.3')).toBe(null)
  })

  it('never reads a channel as a major', () => {
    expect(ceremonyFor({ ...pin, tag: 'latest' }, 'stable')).toBe(null)
  })

  it('yields to the pin’s own ceremony, which applies to every move', () => {
    expect(ceremonyFor({ ...pin, ceremony: 'bounces pg' }, undefined)).toBe('bounces pg')
  })
})
