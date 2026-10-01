// Every server function starts from a builder in server/fn.ts, so who may
// call it is the first word of its definition — and a POST that is not
// `adminFn` is either on the short list below or a failing test.
//
// Read as text, not imported: the rule is about how a file is WRITTEN (what
// the reviewer sees), and importing every server file would drag the
// app's whole server graph into one test.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { adminFn, adminOnly, publicFn, readFn } from './fn'

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

const BUILDERS = ['readFn', 'adminFn', 'publicFn'] as const

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
        expect(text).not.toMatch(/\b(readFn|adminFn|publicFn)\s*\(/)
      })

      it('leaves the admin check to adminFn', () => {
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

  it('readFn is a GET with no check added', () => {
    expect(readFn.options.method).toBe('GET')
    expect(chain(readFn)).not.toContain(adminOnly)
  })

  it('publicFn is a POST with no check', () => {
    expect(publicFn.options.method).toBe('POST')
    expect(chain(publicFn)).not.toContain(adminOnly)
  })
})

// Cross-site POSTs. TanStack Start puts its CSRF middleware in front of every
// server function when the app declares no start instance (src/start.ts):
// a request whose Sec-Fetch-Site is not same-origin — or, with none, whose
// Origin or Referer is not this origin — is answered 403 before any
// middleware here runs. Checked against the running app on 2026-10-01: a
// server-function request marked `cross-site`, or carrying none of the
// three, got 403; `same-origin` got 200. An adminFn's admin gate is not a
// CSRF defence (the admin's own browser carries the session), so this is
// what keeps a page on another *.toscanini.me host from POSTing the santree
// grant or a policy patch. A start.ts that drops the middleware fails here.
describe('server functions refuse cross-site requests', () => {
  it('keeps TanStack Start’s default CSRF middleware, or declares its own', () => {
    const start = ['start.ts', 'start.tsx']
      .map((f) => join(import.meta.dirname, '..', f))
      .find((p) => {
        try {
          readFileSync(p)
          return true
        } catch {
          return false
        }
      })
    if (start === undefined) return
    expect(readFileSync(start, 'utf8')).toMatch(/createCsrfMiddleware/)
  })
})
