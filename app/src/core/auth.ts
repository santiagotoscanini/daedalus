import { getRequestHeader } from '@tanstack/react-start/server'
import { env } from '../host/env'
import { safeEqual } from '../host/github-app-crypto'
import type { Result } from '../lib/result'
import { ADMIN_GROUP } from './auth-names'

// Who is making this request.
//
// There is exactly one source of identity in this app: `X-Forwarded-Email`,
// set by traefik's forward-auth middleware after Pocket ID (auth.headers in
// nix/stacks/daedalus/daedalus.nix). Nothing else authenticates a person, and
// the break-glass local login (core/local-login.ts) is consulted only by
// core/authz.ts when the header is absent.
//
// A header is only as good as who could have sent it, and the container is
// NOT reachable through traefik alone: it shares the monitoring and app-db
// bridges, whose every member can dial it. So every forwarded header is read
// through `forwarded`, which answers only for a request carrying traefik's
// proof — `X-Proxy-Proof`, a per-app secret traefik sets on every request it
// forwards here and the container holds as PROXY_PROOF (webApps.<n>.proxyProof
// in platform/publishing.nix). No proof, a wrong one, or no PROXY_PROOF in the
// environment: the identity headers read as absent, whatever they say. Fail
// closed — a box whose proof never arrived has no signed-in operator, which is
// the refusal to fix, not a gate to open.
//
// One header, but two completely different questions asked of it:
//
//   "who should this record say did it"  — a LABEL. Never fails; an absent
//   header is a placeholder, because a journal line has to say something.
//   `actorLabelOf`, for the `api.*` routes a machine calls.
//
//   "is anyone signed in at all"         — a GATE. An absent header is a
//   refusal, and a blank one must not match another blank one as the same
//   person. `requireActor`, which core/authz.ts asks for every `adminFn`
//   (and hands the answer down as `context.actor`), and `actorOf` for the
//   GitHub callback, which is handed a Request rather than running inside one.
//
// This file reads no file, opens no connection and knows nothing about roles:
// forward-auth already decided, and the box has one operator. Its one outside
// read is PROXY_PROOF, which is why the server functions reach it with
// `await import` (host/boundary.test.ts).

/**
 * What the forward-auth proxy sets, named here so the strings exist once.
 *
 * `EMAIL` answers "who is acting", which is this module's whole subject.
 * `SUBJECT` is the OIDC `sub` and is a different question — it identifies the
 * account at the IdP rather than the person named in a record, so the profile
 * lookup pairs the two and nothing else here uses it. It lives here anyway,
 * because "which headers does the gate in front of us set" is one fact, and
 * spelled in several files it drifts.
 */
export const AUTH_HEADERS = {
  EMAIL: 'x-forwarded-email',
  SUBJECT: 'x-forwarded-user',
  GROUPS: 'x-forwarded-groups',
} as const

const HEADER: string = AUTH_HEADERS.EMAIL

/** The header traefik sets on every request it forwards here, and nothing else can. */
export const PROXY_PROOF_HEADER = 'x-proxy-proof'

type HeaderGet = (name: string) => string | null | undefined

let lastForgeryWarning = 0

/**
 * Whether this request came through traefik: its `X-Proxy-Proof` equals the
 * PROXY_PROOF this container was given, compared in constant time. False when
 * either is missing — there is no configuration in which an unproven request
 * carries an identity.
 */
export function provenByProxy(get: HeaderGet): boolean {
  const expected = env.get('PROXY_PROOF')
  if (expected === undefined || expected === '') return false
  return safeEqual(get(PROXY_PROOF_HEADER) ?? '', expected)
}

/**
 * A forward-auth header, as absent unless traefik is proven to have sent it.
 * An unproven request that names someone is somebody dialling the container
 * around the gate — or a proof that never reached this process — so it is
 * said once a minute, without the value.
 */
function forwarded(get: HeaderGet, name: string): string | null | undefined {
  if (provenByProxy(get)) return get(name)
  const claimed = get(name)
  if (claimed !== null && claimed !== undefined && claimed.trim() !== '') {
    const now = Date.now()
    if (now - lastForgeryWarning > 60_000) {
      lastForgeryWarning = now
      console.warn(
        `[auth] ignored ${name} on a request without traefik's proxy proof — nothing but traefik may name the operator`,
      )
    }
  }
  return undefined
}

/** A forward-auth header of the request this server function is running inside, or absent. */
export const forwardedHeader = (name: string): string | null | undefined =>
  forwarded(getRequestHeader, name)

/** A forward-auth header of a request a caller is holding, or absent. */
export const forwardedHeaderOf = (request: Request, name: string): string | null | undefined =>
  forwarded((n) => request.headers.get(n), name)

// Defined in a module with no server import, so a component can name the group.
export { ADMIN_GROUP }

/** The sentence a mutation answers with when the caller is signed in but not an admin. */
export const NOT_ADMIN_REASON = `Only members of the ${ADMIN_GROUP} group can change this box, so nothing was done.`

/**
 * The groups the forward-auth proxy says this session carries.
 *
 * The header is a JSON array, because Go renders a bare claim list as
 * `[admins family]` — neither JSON nor comma-separated — so daedalus.nix
 * pipes it through the plugin's own `mapToJsonArray`.
 *
 * Every failure (absent, blank, not a JSON array) is the empty list rather
 * than a throw, and a non-string entry is dropped. An empty list can never
 * satisfy `isAdmin`, so every one of them degrades to "not an admin" rather
 * than to an error page.
 */
export function groupsOf(header: string | null | undefined): string[] {
  const raw = header?.trim() ?? ''
  if (raw === '') return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((g): g is string => typeof g === 'string' && g.trim() !== '')
  } catch {
    return []
  }
}

/** The groups of the request this server function is running inside. */
export function requireGroups(): string[] {
  return groupsOf(forwardedHeader(AUTH_HEADERS.GROUPS))
}

/** Whether a group list carries the one that may change this box. */
export const isAdmin = (groups: readonly string[]): boolean => groups.includes(ADMIN_GROUP)

/** What a record says when the request carried no identity to name. */
export const UNKNOWN_ACTOR = 'unknown operator'

/** The one sentence every gated action answers with when the gate is empty. */
export const NO_ACTOR_REASON = 'The request carried no signed-in identity, so nothing was done.'

/** A signed-in operator, or the refusal to hand back. */
export type Actor = Result<string>

const gate = (header: string | null | undefined): Actor => {
  const v = header?.trim() ?? ''
  return v === '' ? { ok: false, reason: NO_ACTOR_REASON } : { ok: true, value: v }
}

/**
 * The gate, over a request a caller is holding — the GitHub callback
 * (core/settings/github-app.ts), which is given one rather than running
 * inside it.
 *
 * Missing or blank is a refusal, never a placeholder: two requests without an
 * identity must not match each other as the same actor.
 */
export function actorOf(request: Request): Actor {
  return gate(forwardedHeaderOf(request, HEADER))
}

/** The gate, over the request this server function is running inside — core/authz.ts `authorize`. */
export function requireActor(): Actor {
  return gate(forwardedHeader(HEADER))
}

/**
 * The display label, over a request a caller is holding. Never fails.
 *
 * The `api.*` routes pass their own fallback — a request that reaches
 * /api/deploy is normally zot's, and "registry" is truer than "unknown
 * operator" for it.
 *
 * Only absence falls back: a header present and blank labels the record with a
 * blank. That is an asymmetry with the gate above, and a known one; closing it
 * is a change to what records say about who wrote them, not to who may act.
 */
export function actorLabelOf(request: Request, fallback: string = UNKNOWN_ACTOR): string {
  return forwardedHeaderOf(request, HEADER) ?? fallback
}
