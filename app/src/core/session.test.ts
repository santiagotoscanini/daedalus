import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { safeNext } from '../lib/safe-next'
import { authEndpoint, identityOf, originOf, sessionOf } from './session'

// The whole sign-in against a fake identity provider: the real @auth/core, with
// only the network stubbed, so what the browser would be sent and what comes
// back are both asserted rather than assumed.

const ISSUER = 'https://id.example.test'
const SITE = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'daedalus.example.test' }

let claims: Record<string, unknown>

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const idToken = () =>
  `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: ISSUER,
    aud: 'daedalus',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 600,
    ...claims,
  })}.signature`

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

/** The two things Auth.js asks the provider for. */
const provider = async (input: RequestInfo | URL): Promise<Response> => {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.pathname === '/.well-known/openid-configuration') {
    return json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      jwks_uri: `${ISSUER}/jwks`,
    })
  }
  if (url.pathname === '/token') {
    return json({ access_token: 'at', token_type: 'bearer', id_token: idToken() })
  }
  return new Response('not found', { status: 404 })
}

beforeEach(() => {
  claims = { sub: 'user-1', email: 'op@example.test', groups: ['admins', 'family'] }
  vi.stubEnv('AUTH_SECRET', 's'.repeat(64))
  vi.stubEnv('OIDC_ISSUER_URL', ISSUER)
  vi.stubEnv('OIDC_CLIENT_ID', 'daedalus')
  vi.stubEnv('OIDC_CLIENT_SECRET', 'client-secret')
  vi.stubEnv('OIDC_PROVIDER_ID', 'pocket-id')
  vi.stubGlobal('fetch', vi.fn(provider))
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://app-daedalus:3000${path}`, { headers: { ...SITE, ...headers } })

/** The Set-Cookie list as a Cookie header, for the browser's next request. */
const cookiesOf = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ')

/** Start, then come back from the provider. The session's Response. */
async function signIn(next = '/settings') {
  const started = await authEndpoint(get(`/api/auth/start?next=${encodeURIComponent(next)}`))
  const authorize = new URL(started.headers.get('location') ?? '')
  const state = authorize.searchParams.get('state') ?? ''
  const back = await authEndpoint(
    get(`/api/auth/callback/pocket-id?code=abc&state=${state}`, { cookie: cookiesOf(started) }),
  )
  return { started, authorize, back }
}

describe('starting a sign-in', () => {
  it('sends the browser to the provider with this box as the way back', async () => {
    const { started, authorize } = await signIn()
    expect(started.status).toBe(302)
    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/authorize`)
    expect(authorize.searchParams.get('client_id')).toBe('daedalus')
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'https://daedalus.example.test/api/auth/callback/pocket-id',
    )
    expect(authorize.searchParams.get('scope')).toContain('groups')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('names the cookies for https, which the proxy terminated', async () => {
    const { started } = await signIn()
    expect(cookiesOf(started)).toContain('__Secure-authjs.state')
  })
})

describe('coming back', () => {
  it('returns to where the visitor was, signed in', async () => {
    const { back } = await signIn('/settings?tab=sign-in')
    expect(back.status).toBe(302)
    expect(back.headers.get('location')).toBe('https://daedalus.example.test/settings?tab=sign-in')
    const session = await sessionOf(get('/', { cookie: cookiesOf(back) }))
    expect(session).toEqual({
      email: 'op@example.test',
      sub: 'user-1',
      groups: ['admins', 'family'],
    })
  })

  it('gives no session to anyone outside the admins group', async () => {
    claims = { sub: 'user-2', email: 'guest@example.test', groups: ['family'] }
    const { back } = await signIn()
    expect(back.headers.get('location')).toContain('/login?error=AccessDenied')
    expect(cookiesOf(back)).not.toContain('session-token')
  })

  it('gives no session to a provider that sends no groups', async () => {
    claims = { sub: 'user-3', email: 'guest@example.test' }
    const { back } = await signIn()
    expect(back.headers.get('location')).toContain('/login?error=AccessDenied')
  })

  it('refuses a callback that did not start here', async () => {
    const back = await authEndpoint(get('/api/auth/callback/pocket-id?code=abc&state=forged'))
    expect(back.headers.get('location')).toContain('/login?error=')
    expect(cookiesOf(back)).not.toContain('session-token')
  })
})

describe('signing out', () => {
  it('clears the session and lands where it will not sign straight back in', async () => {
    const { back } = await signIn()
    const out = await authEndpoint(get('/api/auth/end', { cookie: cookiesOf(back) }))
    expect(out.status).toBe(302)
    expect(out.headers.get('location')).toBe('https://daedalus.example.test/login?signedOut=1')
    expect(out.headers.getSetCookie().join(';')).toMatch(/session-token=;/)
  })
})

describe('what is served', () => {
  it('answers 404 for every action nothing here uses', async () => {
    for (const action of ['session', 'csrf', 'providers', 'signin', 'signout', 'callback/other']) {
      expect((await authEndpoint(get(`/api/auth/${action}`))).status, action).toBe(404)
    }
  })

  it('answers 404 for all of it while no provider is configured', async () => {
    vi.stubEnv('OIDC_ISSUER_URL', '')
    expect((await authEndpoint(get('/api/auth/start'))).status).toBe(404)
  })
})

describe('reading a session', () => {
  it('is nobody without a cookie, or with a forged one', async () => {
    expect(await sessionOf(get('/'))).toBeNull()
    const forged = '__Secure-authjs.session-token=not-a-token'
    expect(await sessionOf(get('/', { cookie: forged }))).toBeNull()
  })

  it('is nobody when the secret changes', async () => {
    const { back } = await signIn()
    vi.stubEnv('AUTH_SECRET', 't'.repeat(64))
    expect(await sessionOf(get('/', { cookie: cookiesOf(back) }))).toBeNull()
  })

  it('takes nothing that is not a whole identity', () => {
    for (const body of [null, {}, { identity: {} }, { identity: { email: ' ', sub: 'x' } }]) {
      expect(identityOf(body)).toBeNull()
    }
    expect(identityOf({ identity: { email: 'a@b', sub: 'x', groups: 'admins' } })?.groups).toEqual(
      [],
    )
  })
})

describe('where a request came from', () => {
  it('is the browser’s origin, not the container’s', () => {
    expect(originOf(get('/'))).toBe('https://daedalus.example.test')
  })

  it('takes the first of a forwarded list', () => {
    const list = new Request('http://app-daedalus:3000/', {
      headers: { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'a.test, b.test' },
    })
    expect(originOf(list)).toBe('https://a.test')
  })
})

describe('where a sign-in may return to', () => {
  it('keeps a path of this app', () => {
    expect(safeNext('/settings?tab=sign-in')).toBe('/settings?tab=sign-in')
  })

  it('never leaves it', () => {
    for (const next of [null, undefined, '', 'https://evil.test', '//evil.test', '/\\evil.test']) {
      expect(safeNext(next), String(next)).toBe('/')
    }
  })
})
