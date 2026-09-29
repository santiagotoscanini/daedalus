import type { Ctx } from '../core/ctx'
import type { ControllerClient } from './controller/client'
import { ControllerError } from './controller/wire'

// Restarting the box: the root helper's `reboot` verb, asked through the
// controller (`root.run`; agent/src/root/, nix/stacks/daedalus/controller.nix
// `root`), the app's one door to root. The helper starts the host's power unit
// (host/power.sh), which refuses mid-rebuild and has no way to power the box
// OFF — that asymmetry is the requirement: the way back on is physical, and
// whoever is looking at this page is usually not in the house.
//
// The answer is the helper's word: the reboot is queued, or refused with the
// unit's reason. Nothing reports the restart finished — the box going down and
// coming back (/api/healthz) is that, and the page watches for it.

/** The helper waits 90 s for the unit (daedalus-verbs.nix `rootVerbs.reboot`); this is that and slack. */
const REBOOT_WAIT_MS = 100_000

export type RebootAnswer =
  | { state: 'rebooting'; detail: string }
  | { state: 'refused'; reason: string }

export async function requestReboot(
  ctx: Pick<Ctx, 'controller'>,
  input: { actor: string },
): Promise<RebootAnswer> {
  console.info(`[power] restart asked by ${input.actor}`)
  let r: Awaited<ReturnType<ControllerClient['rootRun']>>
  try {
    r = await ctx.controller.rootRun('reboot', {}, REBOOT_WAIT_MS)
  } catch (e) {
    // The connection ending with the call unanswered is what the box going
    // down looks like from here: the controller stops with it, possibly
    // before its answer is written.
    if (e instanceof ControllerError && e.code === 'closed') {
      return { state: 'rebooting', detail: 'the controller went away before it answered' }
    }
    return { state: 'refused', reason: e instanceof Error ? e.message : String(e) }
  }
  if (r.outcome === 'done') return { state: 'rebooting', detail: r.detail }
  return { state: 'refused', reason: r.detail === '' ? `the restart ${r.outcome}` : r.detail }
}
