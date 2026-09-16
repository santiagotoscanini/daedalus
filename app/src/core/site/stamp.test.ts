import { describe, expect, it } from 'vitest'
import { renderSiteStamp, type SiteStamp } from './file'

// daedalus.json is a claim about how this directory came to be, made to
// somebody reading a `git log` months later with no other way to check it.
// That makes two properties load-bearing, and they are what this file guards:
//
//   1. a fact that could not be READ is null — never a default, never an
//      empty string, never a stale guess. One invented revision makes every
//      other entry in every other commit unverifiable.
//   2. the bytes are a pure function of the facts: same stamp in, same bytes
//      out, in the same key order and the same byte conventions as the rest
//      of the directory (two spaces, trailing newline). A renderer that
//      reorders keys turns a one-line diff into a whole-file one.
//
// Nothing here reads a snapshot: the gatherers live in core/site/index.ts and
// need the mounts. What is testable without the box is the shape and the
// bytes, and those are the parts that end up committed.

const full: SiteStamp = {
  writtenAt: '2026-09-16T12:00:00.000Z',
  writtenBy: { actor: 'op@example.test', door: 'apply' },
  engine: { version: '1.2.3', head: 'abcdef012345', dirty: false, branch: 'main' },
  config: { revision: 'e2ff338c85d2ce492e156391990eafa9a48b51f9' },
  nixos: { version: '25.11.20260630.b6018f8' },
}

/** Everything the container could not read — the honest empty stamp. */
const unknown: SiteStamp = {
  writtenAt: '2026-09-16T12:00:00.000Z',
  writtenBy: { actor: 'daedalus', door: 'site-write' },
  engine: { version: null, head: null, dirty: null, branch: null },
  config: { revision: null },
  nixos: { version: null },
}

const parsed = (stamp: SiteStamp): Record<string, unknown> =>
  JSON.parse(renderSiteStamp(stamp)) as Record<string, unknown>

describe('the provenance stamp', () => {
  it('carries the whole shape, with the preamble and the schema version', () => {
    const body = parsed(full)
    expect(Object.keys(body)).toEqual([
      '_generated',
      'schemaVersion',
      'writtenAt',
      'writtenBy',
      'engine',
      'config',
      'nixos',
    ])
    expect(body.schemaVersion).toBe(1)
    expect(typeof body._generated).toBe('string')
    // The one thing the preamble must say, because nothing else in the repo
    // does: the build does not read this file.
    expect(String(body._generated)).toMatch(/[Nn]ix does not read it/)
    expect(body.writtenAt).toBe(full.writtenAt)
    expect(body.writtenBy).toEqual({ actor: 'op@example.test', door: 'apply' })
    expect(body.engine).toEqual(full.engine)
    expect(body.config).toEqual({ revision: full.config.revision })
    expect(body.nixos).toEqual({ version: full.nixos.version })
  })

  it('writes null for every fact it could not read, and drops no key', () => {
    const body = parsed(unknown)
    expect(body.engine).toEqual({ version: null, head: null, dirty: null, branch: null })
    expect(body.config).toEqual({ revision: null })
    expect(body.nixos).toEqual({ version: null })
    // A key rendered as `undefined` would vanish from the JSON entirely, and
    // "the field is missing" reads as "an older engine wrote this", which is
    // a different claim from "this engine could not tell".
    const text = renderSiteStamp(unknown)
    expect(text).toContain('"dirty": null')
    expect(text).toContain('"revision": null')
    expect(text).not.toContain('undefined')
  })

  it('never writes an empty string where a fact is unknown', () => {
    const text = renderSiteStamp(unknown)
    expect(text).not.toMatch(/: ""/)
  })

  it('renders the same bytes twice for the same facts', () => {
    expect(renderSiteStamp(full)).toBe(renderSiteStamp(full))
    // …and does not depend on the key order of the object handed in.
    const shuffled: SiteStamp = {
      nixos: full.nixos,
      config: full.config,
      engine: {
        branch: full.engine.branch,
        dirty: full.engine.dirty,
        head: full.engine.head,
        version: full.engine.version,
      },
      writtenBy: { door: full.writtenBy.door, actor: full.writtenBy.actor },
      writtenAt: full.writtenAt,
    }
    expect(renderSiteStamp(shuffled)).toBe(renderSiteStamp(full))
  })

  it('uses the directory’s byte conventions: two spaces, one trailing newline', () => {
    const text = renderSiteStamp(full)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.endsWith('}\n\n')).toBe(false)
    expect(text).toContain('\n  "schemaVersion": 1,')
    expect(text).toContain('\n    "actor": "op@example.test"')
  })

  it('carries nothing the caller was holding beyond the stamp', () => {
    const extra = { ...full, secret: 'do-not-write-this' } as SiteStamp
    expect(renderSiteStamp(extra)).toBe(renderSiteStamp(full))
  })
})
