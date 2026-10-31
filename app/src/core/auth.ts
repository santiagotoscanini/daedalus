import { env } from '../host/env'
import { safeEqual } from '../host/github-app-crypto'
import type { Result } from '../lib/result'
import { ADMIN_GROUP } from './auth-names'

// The small facts about a caller that hold whichever door they came through:
// traefik's proof, and what a list of groups means. Who is signed in is
// core/session.ts, and whether they may change the box is core/authz.ts.
//
// The proof matters because the container is NOT reachable through traefik
// alone: it shares the monitoring and app-db bridges, whose every member can
// dial it. `X-Proxy-Proof` is a per-app secret traefik sets on every request
// it forwards here and the container holds as PROXY_PROOF
// (webApps.<n>.proxyProof in platform/publishing.nix). No proof, a wrong one,
// or no PROXY_PROOF in the environment fails closed.
//
// This file reads no file and opens no connection. Its one outside read is
// PROXY_PROOF, which is why the server functions reach it with `await import`
// (host/boundary.test.ts).

/** The header traefik sets on every request it forwards here, and nothing else can. */
export const PROXY_PROOF_HEADER = 'x-proxy-proof'

type HeaderGet = (name: string) => string | null | undefined

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

// Defined in a module with no server import, so a component can name the group.
export { ADMIN_GROUP }

/** The sentence a mutation answers with when the caller is signed in but not an admin. */
export const NOT_ADMIN_REASON = `Only members of the ${ADMIN_GROUP} group can change this box, so nothing was done.`

/**
 * The groups a claim names. Anything that is not an array is the empty list and
 * a non-string entry is dropped, because a claim is the IdP's to shape and an
 * empty list can never satisfy `isAdmin`: every odd case is "not an admin".
 */
export function groupsOf(claim: unknown): string[] {
  if (!Array.isArray(claim)) return []
  return claim.filter((g): g is string => typeof g === 'string' && g.trim() !== '')
}

/** Whether a group list carries the one that may change this box. */
export const isAdmin = (groups: readonly string[]): boolean => groups.includes(ADMIN_GROUP)

/** The one sentence every gated action answers with when the gate is empty. */
export const NO_ACTOR_REASON = 'The request carried no signed-in identity, so nothing was done.'

/** A signed-in operator, or the refusal to hand back. */
export type Actor = Result<string>
