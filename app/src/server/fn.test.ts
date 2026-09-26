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
import { adminFn, adminOnly, publicFn, readFn } from './fn'

const DIR = 'src/server'

/**
 * Files not yet converted to the builders, which may still call
 * `createServerFn` directly. Converting a file means removing its line here
 * in the same change; the test then holds it to every rule below. Empty is
 * the goal — then delete this list and its one use.
 */
const NOT_YET_CONVERTED = new Set([
  'builds.ts',
  'claude.ts',
  'host.ts',
  'local-login.ts',
  'machines.ts',
  'nodes.ts',
  'players.ts',
  'profile.ts',
  'providers.ts',
  'registry.ts',
  'settings.ts',
  'shell.ts',
  'site.ts',
  'tab-status.ts',
  'updates.ts',
  'versions.ts',
])

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
  it('the allowlist names only files that exist', () => {
    const files = new Set(sources.map((s) => s.file))
    for (const f of NOT_YET_CONVERTED) expect(files, f).toContain(f)
  })

  for (const { file, text } of sources.filter((s) => !NOT_YET_CONVERTED.has(s.file))) {
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
