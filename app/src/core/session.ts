import { Auth, type AuthConfig, skipCSRFCheck } from '@auth/core'
import { env } from '../host/env'
import { isRecord } from '../lib/is-record'
import { safeNext } from '../lib/safe-next'
import { type Actor, groupsOf, isAdmin, NO_ACTOR_REASON } from './auth'
import { type OidcConfig, oidcConfig } from './oidc-config'

// The signed-in person: an Auth.js session over one OIDC provider
// (core/oidc-config.ts), on @auth/core directly, so nothing of it reaches the
// browser bundle.
//
// The session is a sealed JWT cookie and the app keeps no row for it. It lasts
// SESSION_MAX_AGE_S from sign-in and does not slide, so a change at the IdP (a
// group removed, an account disabled) reaches daedalus by the next sign-in at
// the latest.
//
// ONLY `admins` GET A SESSION. On a LAN box the IdP's client already refuses
// everyone else, but a page read needs nothing past a session, so the rule has
// to hold with an IdP that signs in anybody: the day the box is public, that is
// the difference between one operator and the internet reading every page.
//
// THE ORIGIN IS THE CLIENT'S. Behind traefik a request arrives over plain http,
// and @auth/core takes the cookie's name from the URL's scheme and the redirect
// URI from its host, so originOf rebuilds both from the forwarded headers.
// Those are traefik's: the request gate has already refused anything without
// its proof.

const BASE_PATH = '/api/auth'
const SESSION_MAX_AGE_S = 12 * 60 * 60

/** Where a sign-out lands: the login page, told not to sign straight back in. */
const SIGNED_OUT = '/login?signedOut=1'

export type SessionIdentity = {
  email: string
  /** The account at the IdP: survives the person editing their email. */
  sub: string
  groups: string[]
}

const firstOf = (header: string | null): string | undefined =>
  header?.split(',')[0]?.trim() || undefined

/** The scheme and host the browser used. */
export function originOf(request: Request): string {
  const url = new URL(request.url)
  const proto = firstOf(request.headers.get('x-forwarded-proto')) ?? url.protocol.replace(':', '')
  const host =
    firstOf(request.headers.get('x-forwarded-host')) ?? request.headers.get('host') ?? url.host
  return `${proto}://${host}`
}

function configFor(oidc: OidcConfig, secret: string): AuthConfig {
  return {
    basePath: BASE_PATH,
    secret,
    // Traefik is the only way in (core/request-gate.ts), and originOf reads it.
    trustHost: true,
    session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_S },
    pages: { signIn: '/login', error: '/login' },
    // A cookie that does not open is a visitor, not a fault: it reads as nobody,
    // and a public host should not log a stack for each one.
    logger: {
      error: (e) => {
        if (e.name !== 'JWTSessionError') console.error('[auth]', e)
      },
    },
    providers: [
      {
        id: oidc.providerId,
        name: oidc.name,
        type: 'oidc',
        // Discovery is lazy: the first sign-in asks, not the process start, so
        // a box where the IdP comes up second does not crash-loop this one.
        issuer: oidc.issuer,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
        authorization: { params: { scope: oidc.scopes } },
        checks: ['pkce', 'state'],
      },
    ],
    callbacks: {
      signIn: ({ profile }) => isAdmin(groupsOf(profile?.groups)),
      // `profile` is there only on the sign-in itself, and the token keeps it.
      jwt: ({ token, profile }) =>
        profile === undefined
          ? token
          : {
              ...token,
              sub: typeof profile.sub === 'string' ? profile.sub : token.sub,
              email: typeof profile.email === 'string' ? profile.email : token.email,
              groups: groupsOf(profile.groups),
            },
      session: ({ session, token }) => ({
        ...session,
        identity: { email: token.email, sub: token.sub, groups: groupsOf(token.groups) },
      }),
    },
  }
}

const authConfig = (): { oidc: OidcConfig; config: AuthConfig } | null => {
  const oidc = oidcConfig()
  const secret = env.get('AUTH_SECRET')
  if (oidc === null || secret === undefined || secret === '') return null
  return { oidc, config: configFor(oidc, secret) }
}

/** The identity in the session action's answer, or null for anything else. */
export function identityOf(body: unknown): SessionIdentity | null {
  if (!isRecord(body) || !isRecord(body.identity)) return null
  const { email, sub, groups } = body.identity
  if (typeof email !== 'string' || email.trim() === '') return null
  if (typeof sub !== 'string' || sub === '') return null
  return { email: email.trim(), sub, groups: groupsOf(groups) }
}

async function readSession(request: Request): Promise<SessionIdentity | null> {
  const auth = authConfig()
  const cookie = request.headers.get('cookie')
  if (auth === null || cookie === null) return null
  const response = await Auth(
    new Request(`${originOf(request)}${BASE_PATH}/session`, { headers: { cookie } }),
    auth.config,
  )
  // A non-OK body is @auth/core reporting a problem, and must not read as a
  // session. The refreshed cookie it answers with is dropped: sessions do not
  // slide, and a read writes nothing.
  return response.ok ? identityOf(await response.json()) : null
}

// One decrypt per request: an SSR pass asks several times, and each would redo
// the key derivation. Keyed on the Request, so entries are collected with it.
const sessions = new WeakMap<Request, Promise<SessionIdentity | null>>()

/** Who this request's session names, or null. Never sets a cookie. */
export function sessionOf(request: Request): Promise<SessionIdentity | null> {
  const known = sessions.get(request)
  if (known !== undefined) return known
  const read = readSession(request).catch((e: unknown) => {
    console.error('[auth] could not read a session:', e)
    return null
  })
  sessions.set(request, read)
  return read
}

/** "Is anyone signed in", over a request a caller is holding (the GitHub callback). */
export async function actorOf(request: Request): Promise<Actor> {
  const session = await sessionOf(request)
  return session === null
    ? { ok: false, reason: NO_ACTOR_REASON }
    : { ok: true, value: session.email }
}

const notFound = () => new Response('Not Found', { status: 404 })

/** A POST to one of Auth.js's own actions, run in-process and answered as it answers. */
async function act(
  request: Request,
  auth: { config: AuthConfig },
  action: string,
  callbackUrl: string,
): Promise<Response> {
  return Auth(
    new Request(`${originOf(request)}${BASE_PATH}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: request.headers.get('cookie') ?? '',
      },
      body: new URLSearchParams({ callbackUrl }),
    }),
    // These two doors are links, so there is no form to carry Auth.js's token.
    // Starting a sign-in changes nothing, and the callback is bound to the
    // state and PKCE cookies this sets; a forged sign-out costs one redirect.
    { ...auth.config, skipCSRFCheck },
  )
}

/**
 * Everything served under /api/auth, GET only:
 *
 *   start               begin the sign-in, then back to `?next=`
 *   end                 clear the session
 *   callback/<provider> where the IdP returns the browser
 *   error               where @auth/core sends one that failed (pages.error)
 *
 * Every other action Auth.js offers answers 404: nothing here uses them.
 */
export async function authEndpoint(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const action = url.pathname.slice(BASE_PATH.length + 1)
  const auth = authConfig()
  if (auth === null) return notFound()
  if (action === 'start') {
    return act(
      request,
      auth,
      `signin/${auth.oidc.providerId}`,
      safeNext(url.searchParams.get('next')),
    )
  }
  if (action === 'end') return act(request, auth, 'signout', SIGNED_OUT)
  if (action === `callback/${auth.oidc.providerId}` || action === 'error') {
    return Auth(
      new Request(`${originOf(request)}${url.pathname}${url.search}`, request),
      auth.config,
    )
  }
  return notFound()
}
