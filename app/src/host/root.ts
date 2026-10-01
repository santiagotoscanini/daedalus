import type { Ctx } from '../core/ctx'
import type { RootOutcome } from './controller/generated'

// One root verb, the way a page wants it: the root helper's word (agent
// src/root/, nix/stacks/daedalus/controller.nix `root`), asked through the
// controller's `root.run` — the app's one door to root. The helper starts the
// verb's existing unit and answers when it has finished: `done` with the
// unit's words, `refused` with its reason (the unit refused — host/lib.sh
// `refuse` — or it was already running), `failed` when it failed. A call that
// could not be made at all (no controller, a timeout) is `failed` with why.
//
// There is no status file to poll: the answer IS the outcome, and while the
// verb runs the controller keeps its lines (`root.follow`).

export type RootAnswer = { outcome: RootOutcome; detail: string }

export async function runRoot(
  ctx: Pick<Ctx, 'controller'>,
  verb: string,
  selectors: Record<string, string>,
  waitMs: number,
  payload?: string,
): Promise<RootAnswer> {
  try {
    const r = await ctx.controller.call(
      'root.run',
      { verb, selectors, ...(payload === undefined ? {} : { payload }) },
      { waitMs },
    )
    // Null only for a detached run, which this call never asks for.
    return { outcome: r.outcome ?? 'failed', detail: r.detail }
  } catch (e) {
    return { outcome: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * An actor label as a root verb records it (a commit's author line, a journal
 * line). The verbs' `actor` pattern (nix/stacks/daedalus/daedalus-lib.nix
 * `actorPattern`, over the helper's floor: no leading `-`) takes 1 to 128 of
 * `[A-Za-z0-9 ._@+-]`, so anything else becomes `_` and a blank label
 * `unknown`, rather than the helper refusing the click over who made it.
 */
export function rootActor(label: string): string {
  const kept = label
    .replace(/[^A-Za-z0-9 ._@+-]/g, '_')
    .replace(/^-/, '_')
    .slice(0, 128)
  return kept.trim() === '' ? 'unknown' : kept
}

/** The answer as one sentence for a page: the unit's words, or what happened when it had none. */
export function rootAnswerText(a: RootAnswer, what: string): string {
  return a.detail === '' ? `${what} ${a.outcome}` : a.detail
}
