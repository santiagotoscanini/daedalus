import { readSetting, SETTING_KEYS } from '../lib/repo/settings'
import type { Result } from '../lib/result'
import {
  type Actor,
  actorOf,
  groupsOf,
  isAdmin,
  NOT_ADMIN_REASON,
  requireActor,
  requireGroups,
} from './auth'

// Who may CHANGE this box, as opposed to who is signed in.
//
// core/auth.ts answers "is anyone there" and stays pure — no database, no
// environment — because the server-function seam static-imports it. This
// module asks the second question, and cannot be pure: whether the answer is
// enforced is a stored preference, so a caller in `src/server/**` reaches it
// with `await import('../core/authz')` like every other impure module.
//
// THE ROLLOUT, and why the flag exists.
//
// Authorization already exists one layer earlier and always has: the Pocket ID
// client daedalus derives allows `authGroups`, which defaults to [ "admins" ],
// and it is enforced at the IdP — someone outside the group never completes a
// login, so the app never sees the request. What this module adds is defence
// in depth at the thing that actually writes, which matters the day a client
// is widened or a bypass rule grows a path.
//
// But the groups header only exists after daedalus.nix's `auth.headers` gains
// `X-Forwarded-Groups` AND that build is switched. Enforcing before then would
// read an absent header as "not an admin" and refuse the operator on their own
// control plane — a lockout, from a change whose whole purpose is safety. So:
//
//   1. Land the header in nix, switch, and confirm Settings shows `admins`.
//   2. Turn `auth.enforceAdmins` on.
//
// Until step 2 the check still RUNS and still reports, it simply does not
// refuse. That is what `authorize` returns `enforced` for.
//
// MACHINE CALLERS ARE NOT IN SCOPE. /api/deploy (a shared token, checked in
// constant time) and /api/github/webhook (an HMAC signature) authenticate
// something that has no person behind it and no session to carry groups —
// traefik does not even set the header on the paths it bypasses. They keep
// their own auth and must never be given this one.

/** What an authorization decision knows. `enforced` is false while the flag is off. */
export type Authorization = {
  /** The signed-in actor, or the refusal from the identity gate. */
  actor: Actor
  /** The groups the session carries. `[]` when the header has not landed yet. */
  groups: string[]
  /** Whether those groups include the admin group. */
  admin: boolean
  /** Whether a failure here actually refuses, or is only reported. */
  enforced: boolean
}

/** Whether refusal is armed. Off unless the preference says otherwise. */
export async function enforcingAdmins(): Promise<boolean> {
  const on = await readSetting(
    SETTING_KEYS.authEnforceAdmins,
    (v): v is boolean => typeof v === 'boolean',
  )
  return on ?? false
}

const decide = async (actor: Actor, groups: string[]): Promise<Authorization> => ({
  actor,
  groups,
  admin: isAdmin(groups),
  enforced: await enforcingAdmins(),
})

/** The decision for the request this server function is running inside. */
export async function authorize(): Promise<Authorization> {
  return decide(requireActor(), requireGroups())
}

/** The decision for a request a route handler is holding. */
export async function authorizeRequest(request: Request): Promise<Authorization> {
  return decide(actorOf(request), groupsOf(request))
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
  if (decision.enforced && !decision.admin) return { ok: false, reason: NOT_ADMIN_REASON }
  return decision.actor
}

/** The gate most mutations want: the actor, or the refusal, in one call. */
export async function requireAdmin(): Promise<Result<string>> {
  return allow(await authorize())
}

/** The same gate for a route handler holding a Request. */
export async function requireAdminOf(request: Request): Promise<Result<string>> {
  return allow(await authorizeRequest(request))
}

/**
 * The gate as an assertion: the actor, or a throw.
 *
 * This is the form the seam uses, and the choice is deliberate. lib/result.ts's
 * rule is `throw` when the caller can do nothing and `Result` when the refusal
 * is an answer worth rendering — and a refusal here is the first kind. Someone
 * outside `admins` cannot get a session at all, so a mutation that refuses is
 * reporting a broken gate or a widened client, not a decision the person can
 * revisit by editing a form.
 *
 * It also keeps the wiring honest: twenty-nine handlers return nine different
 * shapes, and threading a refusal through each would have meant changing every
 * one of their return types and every component that reads them. A throw is
 * one line at the top of a handler, it cannot be forgotten halfway, and it
 * fails closed — an exception is a 500, never a silent success.
 */
export async function assertAdmin(): Promise<string> {
  const decision = await requireAdmin()
  if (!decision.ok) throw new Error(decision.reason)
  return decision.value
}

/** The assertion for a route handler holding a Request. */
export async function assertAdminOf(request: Request): Promise<string> {
  const decision = await requireAdminOf(request)
  if (!decision.ok) throw new Error(decision.reason)
  return decision.value
}
