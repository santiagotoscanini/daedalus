// Every server function starts from a builder in server/fn.ts, so who may
// call it is the first word of its definition — and a POST that is not
// `adminFn` is either on the short list below or a failing test.
//
// Read as text, not imported: the rule is about how a file is WRITTEN (what
// the reviewer sees), and importing twenty server files would drag the
// app's whole server graph into one test.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adminFn, adminOnly, adminReadFn, publicFn, readFn } from './fn'

const DIR = 'src/server'

/**
 * The POSTs with no admin check, as `file:export`. Each is a door a caller
 * passes through BEFORE they can be an admin, and its definition says why.
 */
const PUBLIC_POSTS = new Set([
  // The break-glass local login (core/local-login.ts): the caller has no
  // identity yet, and getting one is the point. site.json gates it instead.
  'local-login.ts:localSetupFn',
  'local-login.ts:localLoginFn',
  'local-login.ts:localLogoutFn',
])

const BUILDERS = ['readFn', 'adminReadFn', 'adminFn', 'publicFn'] as const

const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'fn.ts')
  .sort()
  .map((file) => ({ file, text: readFileSync(join(DIR, file), 'utf8') }))

/** `export const name = builder` — the definitions, as the reviewer reads them. */
const definitions = (text: string) =>
  [...text.matchAll(/^export const (\w+)\s*=\s*(\w+)\b/gm)].map((m) => ({
    name: m[1] as string,
    root: m[2] as string,
  }))

describe('server functions come from server/fn.ts', () => {
  it('the public list names only functions that exist', () => {
    const defined = new Set(
      sources.flatMap(({ file, text }) => definitions(text).map((d) => `${file}:${d.name}`)),
    )
    for (const p of PUBLIC_POSTS) expect(defined, p).toContain(p)
  })

  for (const { file, text } of sources) {
    describe(file, () => {
      it('never reaches for createServerFn, createMiddleware or .middleware itself', () => {
        expect(text).not.toMatch(/\bcreateServerFn\b/)
        expect(text).not.toMatch(/\bcreateMiddleware\b/)
        expect(text).not.toMatch(/\.middleware\s*\(/)
        // A builder is callable with options: `readFn({ method: 'POST' })`
        // would be a POST with no admin check.
        expect(text).not.toMatch(/\b(readFn|adminReadFn|adminFn|publicFn)\s*\(/)
      })

      it('leaves the admin check to adminFn and adminReadFn', () => {
        expect(text).not.toMatch(/\bassertAdmin\b/)
      })

      it('defines every handler on a builder', () => {
        const handlers = (text.match(/\.handler\s*\(/g) ?? []).length
        const built = definitions(text).filter((d) =>
          (BUILDERS as readonly string[]).includes(d.root),
        )
        expect(built.length).toBe(handlers)
      })

      it('makes a POST adminFn unless it is a listed public door', () => {
        for (const d of definitions(text)) {
          if (d.root !== 'publicFn') continue
          expect(PUBLIC_POSTS, `${file}:${d.name} is publicFn`).toContain(`${file}:${d.name}`)
        }
      })
    })
  }
})

describe('the builders', () => {
  const chain = (b: { options: { middleware?: readonly unknown[] } }) => b.options.middleware ?? []

  it('adminFn is a POST behind adminOnly, and it runs first', () => {
    expect(adminFn.options.method).toBe('POST')
    expect(chain(adminFn)[0]).toBe(adminOnly)
  })

  it('adminReadFn is a GET behind adminOnly, and it runs first', () => {
    expect(adminReadFn.options.method).toBe('GET')
    expect(chain(adminReadFn)[0]).toBe(adminOnly)
    expect(chain(adminReadFn)).toEqual(chain(adminFn))
  })

  it('readFn is a GET with no check added', () => {
    expect(readFn.options.method).toBe('GET')
    expect(chain(readFn)).not.toContain(adminOnly)
  })

  it('publicFn is a POST with no check', () => {
    expect(publicFn.options.method).toBe('POST')
    expect(chain(publicFn)).not.toContain(adminOnly)
  })
})
