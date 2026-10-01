import type { Result } from '../lib/result'
import { type Actor, isAdmin, NOT_ADMIN_REASON, requireActor, requireGroups } from './auth'
import { type LocalIdentity, localIdentity } from './local-login'

// Who may CHANGE this box, as opposed to who is signed in.
//
// core/auth.ts answers "is anyone there" and stays free of the database
// because the server-function seam static-imports it. This module asks the
// second question; it reads the break-glass session (core/local-login.ts), so
// the seam reaches it only through server/fn.ts's `adminOnly`, with
// `await import`.
//
// Authorization already exists one layer earlier: the Pocket ID client
// daedalus derives allows `authGroups`, which defaults to [ "admins" ], and it
// is enforced at the IdP — someone outside the group never completes a login,
// so the app never sees the request. This module is defence in depth at the
// thing that actually writes, which matters the day a client is widened or a
// bypass rule grows a path. It depends on the proxy sending
// `X-Forwarded-Groups` (daedalus.nix's `auth.headers`); a request without it is
// not an admin.
//
// MACHINE CALLERS DO NOT USE THE GATE ABOVE. /api/github/webhook (an HMAC
// signature) and /mcp (a scoped token) authenticate something that has no
// person behind it and no session to carry groups — traefik does not even set
// the header on the paths it bypasses. They keep their own auth; /mcp, whose
// tools drive the same write flows as the buttons, reaches its own narrow door
// at the bottom of this file (assertMachineActor).

/** What an authorization decision knows. */
export type Authorization = {
  /** The signed-in actor, or the refusal from the identity gate. */
  actor: Actor
  /** Whether the session carries the admin group. */
  admin: boolean
}

/**
 * The decision a break-glass local session yields (core/local-login.ts): the
 * same shape the headers produce, with `admins` implied. Pure, so the claim
 * that such a session passes `assertAdmin()` is one test.
 */
export function localAuthorization(identity: LocalIdentity): Authorization {
  return { actor: { ok: true, value: identity.actor }, admin: true }
}

/**
 * The headers first, the local session second. The proxy's word wins when it
 * has one; the session is only consulted when the request carries no
 * forwarded identity, and it answers null without reading a cookie unless
 * site.json turns the login on.
 */
const decide = async (
  actor: Actor,
  groups: string[],
  local: () => Promise<LocalIdentity | null>,
): Promise<Authorization> => {
  if (!actor.ok) {
    const identity = await local()
    if (identity !== null) return localAuthorization(identity)
  }
  return { actor, admin: isAdmin(groups) }
}

/** The decision for the request this server function is running inside. */
export async function authorize(): Promise<Authorization> {
  return decide(requireActor(), requireGroups(), () => localIdentity())
}

/**
 * Turn a decision into the actor a mutation may proceed with, or the sentence
 * it refuses with.
 *
 * Order matters: an absent identity is reported as an absent identity even
 * when the group check would also have failed, because "you are not signed in"
 * and "you are not an admin" send the operator to different places.
 */
export function allow(decision: Authorization): Result<string> {
  if (!decision.actor.ok) return decision.actor
  if (!decision.admin) return { ok: false, reason: NOT_ADMIN_REASON }
  return decision.actor
}

/** The gate most mutations want: the actor, or the refusal, in one call. */
async function requireAdmin(): Promise<Result<string>> {
  return allow(await authorize())
}

/**
 * The gate as an assertion: the actor, or a throw.
 *
 * This is the form every `adminFn` runs (server/fn.ts `adminOnly`), and the
 * choice is deliberate. lib/result.ts's
 * rule is `throw` when the caller can do nothing and `Result` when the refusal
 * is an answer worth rendering — and a refusal here is the first kind. Someone
 * outside `admins` cannot get a session at all, so a mutation that refuses is
 * reporting a broken gate or a widened client, not a decision the person can
 * revisit by editing a form.
 *
 * It also keeps the wiring honest: the admin functions return many different
 * shapes, and threading a refusal through each would mean changing every one
 * of their return types and every component that reads them. A throw sits in
 * one middleware ahead of them all, and it fails closed — an exception is a
 * 500, never a silent success.
 */
export async function assertAdmin(): Promise<string> {
  const decision = await requireAdmin()
  if (!decision.ok) throw new Error(decision.reason)
  return decision.value
}

// ── The one door for a caller that is not a person ─────────────────────────
//
// Everything above answers "which signed-in human is this, and are they an
// admin". The MCP server at /mcp has no such caller: there are no forward-auth
// headers on that path at all (traefik's plugin only sets them on gated paths,
// and /mcp is in `authBypassRule` precisely so an agent can reach it), so
// `assertAdmin()` would read an absent identity as a refusal and turn every
// tool call into a 500.
//
// The answer is NOT to weaken `assertAdmin`. A bypass flag on the human gate
// is how a gate stops meaning anything: it would be one boolean away from
// letting an unauthenticated browser request through the same hole. So the
// machine caller gets its own named function, which can be grepped, reviewed
// and counted — there are exactly as many machine-authorised call sites as
// there are references to this symbol.
//
// WHAT AUTHORISES IT. The scoped token, checked in constant time against a
// stored digest before any work happens (host/mcp/tokens.ts), exactly as
// `/api/github/webhook`'s HMAC is for that one. The token IS the
// authorization; this function's job is to refuse a proof that does not
// actually say so, and to name the actor the write will be recorded under.

/**
 * What a verified machine caller hands in. A nominal-ish shape rather than a
 * bare string, so `assertMachineActor(someUserInput)` does not typecheck.
 */
export type MachineProof = {
  /** Which machine door this came through. One value today; more would each need their own review. */
  door: 'mcp-token'
  /** The token's label. This is what the write is recorded under. */
  label: string
  /** The token's scope. Only `write` may authorise a mutation. */
  scope: 'read' | 'write'
}

/**
 * The actor a token-authenticated mutation may proceed with, or a throw.
 *
 * Mirrors `assertAdmin()`'s contract deliberately — same return type, same
 * failure mode, so a write flow reads identically whichever door reached it —
 * and shares none of its mechanism, because there is no session and no group
 * header to read.
 */
export function assertMachineActor(proof: MachineProof): string {
  if (proof.door !== 'mcp-token') throw new Error('unknown machine door')
  if (proof.scope !== 'write') {
    throw new Error('this token is read-only, so nothing was done')
  }
  const label = proof.label.trim()
  if (label === '') throw new Error('the token carried no label to record the write under')
  // Namespaced, always. A record that says `triage` is indistinguishable from
  // a person called triage; one that says `mcp:triage` says which door it came
  // through, which is the fact an audit actually wants.
  return `mcp:${label}`
}
