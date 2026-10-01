// Every server function starts from a builder in server/fn.ts, so who may
// call it is the first word of its definition — and a POST that is not
// `adminFn` is either on the short list below or a failing test.
//
// Read as text, not imported: the rule is about how a file is WRITTEN (what
// the reviewer sees), and importing every server file would drag the
// app's whole server graph into one test.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redirect } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminFn, adminOnly, plainErrors, publicFn, readFn } from './fn'

// The admin gate's verdict, steered per test: an actor, or the throw.
const authz = vi.hoisted(() => ({ assertAdmin: vi.fn<() => Promise<string>>() }))
vi.mock('../core/authz', () => authz)

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

      it('records under the actor adminFn admitted, never one read again from the headers', () => {
        // A second read sees only the forwarded header, so a break-glass
        // session would pass the gate and then be refused, or be recorded as
        // nobody.
        expect(text).not.toMatch(/\b(requireActor|actorOf|actorLabel)\b/)
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

  it('adminFn is a POST behind adminOnly, the first link that checks anything', () => {
    expect(adminFn.options.method).toBe('POST')
    // plainErrors only wraps: it runs nothing before the gate.
    expect(chain(adminFn).slice(0, 2)).toEqual([plainErrors, adminOnly])
  })

  it('every builder hands the browser plain errors, around everything else', () => {
    for (const b of [readFn, adminFn, publicFn]) expect(chain(b)[0]).toBe(plainErrors)
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

describe('adminOnly', () => {
  type Next = (opts?: { context?: Record<string, unknown> }) => Promise<unknown>
  const server = (adminOnly as unknown as { options: { server: (o: unknown) => Promise<unknown> } })
    .options.server
  const call = (next: Next) => server({ next, serverFnMeta: { name: 'revealEnvVar' } })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hands the handler the actor the gate admitted, and audits the call', async () => {
    // `local:` is the break-glass session: no forwarded header at all, which a
    // second read from the headers would have taken for nobody.
    authz.assertAdmin.mockResolvedValue('local:ops')
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const next = vi.fn<Next>(async () => 'ran')

    expect(await call(next)).toBe('ran')
    expect(next).toHaveBeenCalledWith({ context: { actor: 'local:ops' } })
    expect(info).toHaveBeenCalledWith('[audit] local:ops revealEnvVar')
  })

  it('throws before the handler when the gate refuses, and audits nothing', async () => {
    authz.assertAdmin.mockRejectedValue(new Error('not an admin'))
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const next = vi.fn<Next>(async () => 'ran')

    await expect(call(next)).rejects.toThrow('not an admin')
    expect(next).not.toHaveBeenCalled()
    expect(info).not.toHaveBeenCalled()
  })
})

describe('plainErrors', () => {
  type Next = () => Promise<unknown>
  const server = (
    plainErrors as unknown as { options: { server: (o: unknown) => Promise<unknown> } }
  ).options.server
  const call = (next: Next) => server({ next, serverFnMeta: { name: 'fetchThing' } })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('hands the browser the first line, redacted, and logs the original here', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const original = Object.assign(
      new Error(
        'git push failed\nremote: https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123456789@github.com',
      ),
      { cause: new Error('/home/operator/.config/secret'), stdout: 'Bearer abc.def.ghi' },
    )

    const thrown = await call(async () => {
      throw original
    }).catch((e: unknown) => e)

    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as Error).message).toBe('git push failed')
    // Nothing else of the original is left to serialise.
    expect((thrown as Error).cause).toBeUndefined()
    expect(Object.keys(thrown as object)).toEqual([])
    expect((thrown as Error).stack).toBe('Error: git push failed')
    expect(logged).toHaveBeenCalledWith('[server-fn] fetchThing failed:', original)
  })

  it('redacts a secret in the first line', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const thrown = await call(async () => {
      throw new Error('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 was refused')
    }).catch((e: unknown) => e)
    expect((thrown as Error).message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('lets a redirect through untouched', async () => {
    const to = redirect({ to: '/apps' })
    await expect(
      call(async () => {
        throw to
      }),
    ).rejects.toBe(to)
  })

  it('passes a result through', async () => {
    expect(await call(async () => 'ok')).toBe('ok')
  })
})
