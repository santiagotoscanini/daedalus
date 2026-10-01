import { isNotFound, isRedirect } from '@tanstack/react-router'
import { createMiddleware, createServerFn } from '@tanstack/react-start'
import type { Ctx } from '../core/ctx'
import { errorText } from '../lib/redact'

// The builders every server function in this directory starts from.
//
// Who may call a function is the first thing a reviewer asks of it, so it is
// the first word of the definition — `adminFn`, `readFn` or `publicFn` — not
// a check inside the handler that a new mutation could leave out.
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
// Every impure module — here and in every handler in this directory — is
// reached with `await import` inside the server-side body, which the compiler
// erases from the browser's copy of the file. A static value import of one
// would land in the client chunk of every route that uses the function;
// host/boundary.test.ts refuses it.

/**
 * What a thrown error tells the browser: its first line, redacted and capped
 * (lib/redact.ts `errorText`), in a plain Error. The original — its stack, its
 * cause, any property a library hung on it — is serialised whole otherwise,
 * and those carry paths, upstream bodies and the words of subprocesses. So
 * the original is logged here, server-side, and only the sentence crosses.
 *
 * First in every chain, so it wraps the admin gate's refusal and the
 * validator's too. A redirect or a not-found is the router's control flow,
 * not an error, and passes through untouched.
 */
export const plainErrors = createMiddleware({ type: 'function' }).server(
  async ({ next, serverFnMeta }) => {
    try {
      return await next()
    } catch (e) {
      if (isRedirect(e) || isNotFound(e)) throw e
      console.error(`[server-fn] ${serverFnMeta.name} failed:`, e)
      const plain = new Error(errorText(e))
      // Its own stack would name this file and the framework's; the sentence is all.
      plain.stack = `Error: ${plain.message}`
      throw plain
    }
  },
)

/**
 * `context.ctx()`: the request's Ctx (core/ctx.ts), built on first use and
 * shared after that. Lazy, so a function that never needed one still never
 * builds one — makeCtx reads snapshots and the host inventory.
 */
const withCtx = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  let made: Promise<Ctx> | undefined
  const ctx = (): Promise<Ctx> => {
    made ??= import('../core/ctx').then((m) => m.makeCtx())
    return made
  }
  return next({ context: { ctx } })
})

/**
 * The admin gate, `assertAdmin()` (core/authz.ts): passes, or throws before the
 * validator and handler run.
 *
 * What it passes with is `context.actor`: the operator the gate admitted — the
 * forwarded email, or `local:<name>` for a break-glass session — and every
 * record the mutation writes (a commit, a request file, a journal line) is made
 * under it. Handed down rather than read again from the headers, so a mutation
 * cannot admit one identity and record another, and nothing below the gate
 * has an absent identity left to handle.
 *
 * One `[audit]` line per call, naming the actor and the function: a mutation
 * is audited by being one, not by remembering to log.
 */
export const adminOnly = createMiddleware({ type: 'function' }).server(
  async ({ next, serverFnMeta }) => {
    const { assertAdmin } = await import('../core/authz')
    const actor = await assertAdmin()
    console.info(`[audit] ${actor} ${serverFnMeta.name}`)
    return next({ context: { actor } })
  },
)

/** A read (GET). No check added: reads are open to anyone past the proxy's gate. */
export const readFn = createServerFn().middleware([plainErrors, withCtx])

/** A mutation (POST), refused unless `assertAdmin()` passes — before the validator runs. */
export const adminFn = createServerFn({ method: 'POST' }).middleware([
  plainErrors,
  adminOnly,
  withCtx,
])

/**
 * A POST with NO admin check. Only for a door a caller must pass through
 * before they can be an admin (server/local-login.ts). Every use carries a
 * comment saying why, and `server/fn.test.ts` holds the list — adding one
 * means editing that list in the same review.
 */
export const publicFn = createServerFn({ method: 'POST' }).middleware([plainErrors, withCtx])
