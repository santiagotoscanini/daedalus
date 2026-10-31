import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXEMPT, gate, isOpen, READER_TOKEN_HEADER, verdictOf } from './request-gate'

// The gate in front of every request: who may be served without traefik's
// proof. Each refusal below is somebody on a shared bridge dialling the
// container directly.

const PROOF = 'p'.repeat(64)
const READER = 'r'.repeat(64)

beforeEach(() => {
  vi.stubEnv('PROXY_PROOF', PROOF)
  vi.stubEnv('READER_TOKEN', READER)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const req = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`http://app-daedalus:3000${path}`, { method, headers })

describe('a request with traefik’s proof', () => {
  it('passes, whatever the path or method', () => {
    for (const [path, method] of [
      ['/settings', 'GET'],
      ['/_serverFn/abc', 'POST'],
      ['/api/profile-picture', 'GET'],
    ] as const) {
      expect(verdictOf(req(path, { 'x-proxy-proof': PROOF }, method))).toBe('proxied')
    }
  })
})

describe('a request without it', () => {
  it('is refused on a page, a server function and an image route', () => {
    for (const path of [
      '/settings',
      '/_serverFn/abc',
      '/api/app-icon/iris',
      '/api/shot-run/a/b.png',
    ]) {
      expect(verdictOf(req(path))).toBe('unproven')
    }
  })

  it('is refused with a wrong proof, or when the container was given none', () => {
    expect(verdictOf(req('/settings', { 'x-proxy-proof': 'q'.repeat(64) }))).toBe('unproven')
    vi.stubEnv('PROXY_PROOF', '')
    expect(verdictOf(req('/settings', { 'x-proxy-proof': '' }))).toBe('unproven')
  })

  it('passes the doors that authenticate their caller themselves, by exact path', () => {
    for (const path of Object.keys(EXEMPT)) expect(verdictOf(req(path, {}, 'POST'))).toBe('exempt')
    for (const path of [
      '/api/healthz/',
      '/API/healthz',
      '/mcp/x',
      '/api/healthz/../settings',
      '/api/healthz%2F..%2Fsettings',
    ]) {
      expect(verdictOf(req(path)), path).toBe('unproven')
    }
  })
})

describe('the reader token', () => {
  it('reads: a GET or HEAD with the token passes, carrying no identity', () => {
    for (const method of ['GET', 'HEAD']) {
      expect(verdictOf(req('/settings', { [READER_TOKEN_HEADER]: READER }, method))).toBe('reader')
    }
  })

  it('never writes: a POST with the token is refused, so it cannot reach an adminFn', () => {
    expect(verdictOf(req('/_serverFn/abc', { [READER_TOKEN_HEADER]: READER }, 'POST'))).toBe(
      'unproven',
    )
  })

  it('is refused when wrong, or when the container was given none', () => {
    expect(verdictOf(req('/settings', { [READER_TOKEN_HEADER]: 'x'.repeat(64) }))).toBe('unproven')
    vi.stubEnv('READER_TOKEN', '')
    expect(verdictOf(req('/settings', { [READER_TOKEN_HEADER]: '' }))).toBe('unproven')
  })
})

describe('the exempt list', () => {
  // A stale entry is a hole waiting for a route to be added under its name.
  it('names only routes that exist', () => {
    const routes = readdirSync(join(import.meta.dirname, '..', 'routes'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => `/${f.replace(/\.ts$/, '').replaceAll('.', '/')}`)
    for (const path of Object.keys(EXEMPT)) expect(routes).toContain(path)
  })
})

describe('the request middleware', () => {
  it('runs the gate before anything else, then the CSRF check', () => {
    const start = readFileSync(join(import.meta.dirname, '..', 'start.ts'), 'utf8')
    expect(start).toMatch(/requestMiddleware: \[requestGate, csrf\]/)
  })
})

describe('the gate', () => {
  const yes = () => Promise.resolve(true)
  const no = () => Promise.resolve(false)
  const proved = { 'x-proxy-proof': PROOF }

  it('answers 403 instead of the app, and says so once a minute per path', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    for (const r of [req('/claude'), req('/claude?tab=x')]) {
      const refused = await gate(r, yes)
      expect(refused?.status).toBe(403)
      expect(await refused?.text()).toBe('Forbidden')
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toBe(
      '[gate] refused GET /claude: no proxy proof, not an exempt path, no reader token',
    )
  })

  it('lets a session, the exempt and the reader through to the app', async () => {
    expect(await gate(req('/claude', proved), yes)).toBeNull()
    expect(await gate(req('/api/healthz'), no)).toBeNull()
    expect(await gate(req('/claude', { [READER_TOKEN_HEADER]: READER }), no)).toBeNull()
  })

  it('never lets a session stand in for the proof', async () => {
    expect((await gate(req('/claude'), yes))?.status).toBe(403)
    expect((await gate(req('/login'), yes))?.status).toBe(403)
    expect((await gate(req('/api/auth/start'), yes))?.status).toBe(403)
  })

  it('sends a page with no session to sign in, and back to where it was', async () => {
    const r = await gate(req('/settings?tab=network', proved), no)
    expect(r?.status).toBe(302)
    expect(r?.headers.get('location')).toBe('/login?next=%2Fsettings%3Ftab%3Dnetwork')
  })

  it('answers 401 to what is not a page: a read, an image, an API', async () => {
    for (const path of ['/_serverFn/abc', '/api/profile-picture', '/api/shot-run/x']) {
      expect((await gate(req(path, proved), no))?.status, path).toBe(401)
    }
  })

  it('refuses a POST to a page or a route with no session', async () => {
    expect((await gate(req('/settings', proved, 'POST'), no))?.status).toBe(401)
  })
})

describe('what a proxied request reaches with no session', () => {
  it('is the way to get one', () => {
    expect(isOpen(req('/login'))).toBe(true)
    expect(isOpen(req('/api/auth/start'))).toBe(true)
    expect(isOpen(req('/api/auth/callback/pocket-id'))).toBe(true)
  })

  it('is a POST to a server function, which gates itself', () => {
    expect(isOpen(req('/_serverFn/abc', {}, 'POST'))).toBe(true)
  })

  it('is every exempt door', () => {
    for (const path of Object.keys(EXEMPT)) expect(isOpen(req(path)), path).toBe(true)
  })

  it('is not a read, or anything that only looks like the above', () => {
    for (const path of ['/_serverFn/abc', '/apps', '/', '/loginx', '/api/authx', '/api/auth']) {
      expect(isOpen(req(path)), path).toBe(false)
    }
  })
})
