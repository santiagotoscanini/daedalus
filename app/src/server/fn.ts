import { createMiddleware, createServerFn } from '@tanstack/react-start'
import type { Ctx } from '../core/ctx'

// The builders every server function in this directory starts from.
//
// Who may call a function is the first thing a reviewer asks of it, and it
// used to be two lines inside each handler — `await import('../core/authz')`
// then `await assertAdmin()` — which a new mutation could simply leave out.
// Here it is the first word instead: `adminFn` or `readFn`, and
// `server/fn.test.ts` fails on a POST that is neither `adminFn` nor on its
// short list of `publicFn` doors.
//
// Builders are CONSTANTS, not functions: the Start compiler follows an
// imported binding back to `createServerFn(...)` to find a server function,
// and it cannot see through a call. `adminFn.validator(...).handler(...)` in
// another file is therefore still a server function, whose RPC id is still
// that file plus that export's name. A builder is immutable — every
// `.validator`/`.handler` returns a new one — so sharing it is safe.
//
// Middleware runs BEFORE the function's validator (that is TanStack's order:
// the validator belongs to the last link of the chain). So a non-admin
// sending a malformed body is told they are not an admin rather than what the
// shape should be — the refusal comes first, which is the right way round.
//
// Every impure module is reached with `await import` inside a `.server()`
// body, which the compiler erases from the browser's copy of this file.

/**
 * `context.ctx()`: the request's Ctx (core/ctx.ts), built on first use and
 * shared after that. Lazy, so a function that never needed one still never
 * builds one — makeCtx reads snapshots and the host inventory.
 */
export const withCtx = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  let made: Promise<Ctx> | undefined
  const ctx = (): Promise<Ctx> => {
    made ??= import('../core/ctx').then((m) => m.makeCtx())
    return made
  }
  return next({ context: { ctx } })
})

/**
 * `context.actor()`: the label a record written by this request carries —
 * exactly `actorLabel()` (core/auth.ts), read when asked. The forward-auth
 * middleware forwards the Pocket ID claim as a header, so a commit, request
 * file or journal line written with it names a person rather than
 * "daedalus". A label, never a
 * gate: it answers a placeholder rather than refusing. A function that must
 * refuse an absent identity still calls `requireActor()` itself.
 */
export const withActor = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const { actorLabel } = await import('../core/auth')
  return next({ context: { actor: (): string => actorLabel() } })
})

/** Exactly what `await assertAdmin()` at the top of a handler did: the actor, or a throw. */
export const adminOnly = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const { assertAdmin } = await import('../core/authz')
  await assertAdmin()
  return next()
})

/** A read (GET). No check added: reads are open to anyone past the proxy's gate. */
export const readFn = createServerFn().middleware([withActor, withCtx])

/** A mutation (POST), refused unless `assertAdmin()` passes — before the validator runs. */
export const adminFn = createServerFn({ method: 'POST' }).middleware([
  adminOnly,
  withActor,
  withCtx,
])

/**
 * A read (GET) only an admin may make — adminFn's chain on a GET, for a read
 * that reaches something a non-admin must not (players.ts's vendor lookup).
 * The check runs before the validator here too.
 */
export const adminReadFn = createServerFn().middleware([adminOnly, withActor, withCtx])

/**
 * A POST with NO admin check. Only for a door a caller must pass through
 * before they can be an admin (server/local-login.ts). Every use carries a
 * comment saying why, and `server/fn.test.ts` holds the list — adding one
 * means editing that list in the same review.
 */
export const publicFn = createServerFn({ method: 'POST' }).middleware([withActor, withCtx])
