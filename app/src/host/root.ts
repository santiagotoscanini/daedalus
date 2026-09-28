import { type ControllerClient, controller } from './controller/client'
import type { RootOutcome } from './controller/wire'

// One root verb, the way a page wants it: the root helper's word (agent
// src/root/, nix/stacks/daedalus/controller.nix `root`), asked through the
// controller's `root.run` — the app's one door to root. The helper starts the
// verb's existing unit and answers when it has finished: `done` with the
// unit's last line, `refused` with its reason (the unit said `refused: …`, or
// it was already running), `failed` when it failed. A call that could not be
// made at all (no controller, a timeout) is `failed` with why.
//
// There is no status file to poll: the answer IS the outcome, and while the
// verb runs its lines go out as `root.progress` events.

export type RootAnswer = { outcome: RootOutcome; detail: string }

export async function runRoot(
  verb: string,
  selectors: Record<string, string>,
  waitMs: number,
  client: ControllerClient = controller(),
): Promise<RootAnswer> {
  try {
    const r = await client.rootRun(verb, selectors, waitMs)
    return { outcome: r.outcome, detail: r.detail }
  } catch (e) {
    return { outcome: 'failed', detail: e instanceof Error ? e.message : String(e) }
  }
}

/** The answer as one sentence for a page: the unit's words, or what happened when it had none. */
export function rootAnswerText(a: RootAnswer, what: string): string {
  return a.detail === '' ? `${what} ${a.outcome}` : a.detail
}
