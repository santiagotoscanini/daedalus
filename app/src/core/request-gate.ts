import { env } from '../host/env'
import { safeEqual } from '../host/github-app-crypto'
import { provenByProxy } from './auth'

// The one gate in front of every request this app serves — pages, server
// functions and `api.*` routes alike — run as request middleware (src/start.ts)
// before any of them.
//
// The container is not reachable through traefik alone: it shares bridges
// (app-db, monitoring and others) whose every member can dial it, and the
// production server answers any Host. The proxy proof on its own only blanks
// the identity headers (core/auth.ts); a read — a GET server function, a
// page's loader — would still answer whoever dialled. So a request needs one
// of three things:
//
//   traefik's proof    — `X-Proxy-Proof`, which only traefik can send. Every
//                        request through the app's own routers carries it,
//                        bypassed paths included.
//   an exempt path     — the doors that authenticate their caller themselves,
//                        listed in EXEMPT with the reason each may.
//   the reader token   — `X-Reader-Token`, a machine-generated READER_TOKEN
//                        the host hands this container and the one tool that
//                        dials the container under the gate (the headless
//                        browser). A GET or HEAD only, and no identity rides
//                        with it — the identity headers stay unproven — so it
//                        reads pages and never passes `adminFn`.
//
// Static files never reach this: the production server answers them before
// the app handler (server.mjs), and the dev server before Start's.
//
// A refusal is a bare 403 before any route or server function runs, and one
// journal line per path a minute — the method and the path, never a header, a
// query or a body.
//
// Proof says traefik sent a request, not that a person did. So a proxied
// request also needs a session (core/session.ts), or the break-glass one,
// unless it is on the short list of what a visitor must reach to get one:
// `isOpen`. A page is sent to /login; anything else is a 401.

/** The paths served without traefik's proof, and why each may be. Exact matches only. */
export const EXEMPT: Readonly<Record<string, string>> = {
  '/api/healthz':
    'readiness only — a status word and nothing else; the deploy unit and gatus probe it',
  '/mcp': 'a scoped bearer token, matched against its stored digest before any work',
  '/api/github/webhook':
    'an HMAC over the raw body; GitHub arrives through the hooks router, which sets no proof',
  '/api/agent/enroll': 'a single-use code, redeemed only with the PKCE verifier it was bound to',
}

/** The header the reader token rides in. */
export const READER_TOKEN_HEADER = 'x-reader-token'

/** Why a request may proceed, or that it may not. */
export type Verdict = 'proxied' | 'exempt' | 'reader' | 'unproven'

const READS = new Set(['GET', 'HEAD'])

function readerTokenMatches(sent: string | null): boolean {
  const expected = env.get('READER_TOKEN')
  if (expected === undefined || expected === '') return false
  return safeEqual(sent ?? '', expected)
}

/** The gate's decision for one request. Pure but for the two secrets in the environment. */
export function verdictOf(request: Request): Verdict {
  const get = (name: string) => request.headers.get(name)
  if (provenByProxy(get)) return 'proxied'
  if (Object.hasOwn(EXEMPT, new URL(request.url).pathname)) return 'exempt'
  if (READS.has(request.method) && readerTokenMatches(get(READER_TOKEN_HEADER))) return 'reader'
  return 'unproven'
}

const LOG_EVERY_MS = 60_000
const lastLogged = new Map<string, number>()

/** One line per method and path a minute. */
function logRefusal(request: Request): void {
  const key = `${request.method} ${new URL(request.url).pathname.slice(0, 200)}`
  const now = Date.now()
  if (now - (lastLogged.get(key) ?? 0) < LOG_EVERY_MS) return
  if (lastLogged.size >= 1000) lastLogged.clear()
  lastLogged.set(key, now)
  console.warn(`[gate] refused ${key}: no proxy proof, not an exempt path, no reader token`)
}

/**
 * What a proxied request reaches with no session.
 *
 * A POST to a server function passes because each one gates itself: it is an
 * `adminFn` or one of the login's `publicFn`s, and server/fn.test.ts fails on
 * anything else. A GET one is a read, and reads have no check but this file's.
 */
export function isOpen(request: Request): boolean {
  const { pathname } = new URL(request.url)
  return (
    pathname === '/login' ||
    pathname.startsWith('/api/auth/') ||
    Object.hasOwn(EXEMPT, pathname) ||
    (request.method === 'POST' && pathname.startsWith('/_serverFn/'))
  )
}

const noStore = { 'cache-control': 'no-store' }

function toSignIn(request: Request): Response {
  const { pathname, search } = new URL(request.url)
  const isPage =
    READS.has(request.method) &&
    !pathname.startsWith('/api/') &&
    !pathname.startsWith('/_serverFn/')
  if (!isPage) return new Response('Unauthorized', { status: 401, headers: noStore })
  const next = encodeURIComponent(`${pathname}${search}`)
  return new Response(null, {
    status: 302,
    headers: { ...noStore, location: `/login?next=${next}` },
  })
}

/**
 * What the request middleware answers instead of the app, or null to let it
 * through. `signedIn` is the only part that reads a cookie or a row, handed in
 * so the rules can be asserted without either.
 */
export async function gate(
  request: Request,
  signedIn: (request: Request) => Promise<boolean>,
): Promise<Response | null> {
  const verdict = verdictOf(request)
  if (verdict === 'unproven') {
    logRefusal(request)
    return new Response('Forbidden', { status: 403, headers: noStore })
  }
  if (verdict !== 'proxied' || isOpen(request) || (await signedIn(request))) return null
  return toSignIn(request)
}
