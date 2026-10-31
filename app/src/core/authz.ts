import { getRequest } from '@tanstack/react-start/server'
import type { Result } from '../lib/result'
import { type Actor, isAdmin, NO_ACTOR_REASON, NOT_ADMIN_REASON } from './auth'
import { type LocalIdentity, localIdentity } from './local-login'
import { sessionOf } from './session'

// Who may CHANGE this box, as opposed to who is signed in.
//
// This module reads the session and the break-glass login, so the seam reaches
// it only through server/fn.ts's `adminOnly`, with `await import`.
//
// Authorization exists one layer earlier too: core/session.ts gives a session
// only to `admins`, and the Pocket ID client refuses everyone else before that.
// This module is defence in depth at the thing that actually writes, which
// matters the day either of those is widened.
//
// MACHINE CALLERS DO NOT USE THE GATE ABOVE. /api/github/webhook (an HMAC
// signature) and /mcp (a scoped token) authenticate something that has no
// person behind it and no session to carry groups. They keep their own auth;
// /mcp, whose tools drive the same write flows as the buttons, reaches its own
// narrow door at the bottom of this file (assertMachineActor).

/** What an authorization decision knows. */
export type Authorization = {
  /** The signed-in actor, or the refusal from the identity gate. */
  actor: Actor
  /** Whether the session carries the admin group. */
  admin: boolean
}

/**
 * The decision a break-glass local session yields (core/local-login.ts): the
 * same shape a session produces, with `admins` implied. Pure, so the claim
 * that such a session passes `assertAdmin()` is one test.
 */
export function localAuthorization(identity: LocalIdentity): Authorization {
  return { actor: { ok: true, value: identity.actor }, admin: true }
}

/**
 * The IdP's session first, the local one second: it is only consulted when the
 * request carries no session, and it answers null without reading a cookie
 * unless site.json turns the login on.
 */
export const decide = async (
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
  const session = await sessionOf(getRequest())
  const actor: Actor =
    session === null ? { ok: false, reason: NO_ACTOR_REASON } : { ok: true, value: session.email }
  return decide(actor, session?.groups ?? [], () => localIdentity())
}

/** Whether a request carries either session: the request gate's question. */
export async function signedIn(request: Request): Promise<boolean> {
  return (await sessionOf(request)) !== null || (await localIdentity()) !== null
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
// admin". The MCP server at /mcp has no such caller and no session, so
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
