import {
  type ImageTarget,
  type ImageUpdateStatus,
  readImageUpdateStatus,
  requestImageUpdate,
} from './image-update'

// The one image-update implementation.
//
// Both doors — the Update button and the scriptable POST /api/image-update —
// call runImageUpdate and only translate its outcome into their own response
// shape. Same argument as lib/apply-flow.ts, which this deliberately mirrors:
// two hand-copied bodies are two bodies that drift.
//
// A queued batch is not a third door. It is the same call with more targets,
// which is what keeps "several at once" from becoming a second mechanism with
// its own busy rule and its own way of being wrong.

export type UpdateOutcome =
  | { ok: true; id: string; targets: { container: string; toTag: string | null }[] }
  | { ok: false; code: 'busy' | 'refused'; reason: string }

/**
 * How long a published request may sit unclaimed before a new one may replace
 * it. Same value and same reason as apply: the path unit normally reacts
 * within a second, and refusing forever would wedge the button until a
 * container restart.
 */
const PICKUP_MS = 120_000

/**
 * The last request published and not yet acknowledged in image-status.json.
 *
 * Closes the window the status file cannot: between `requestImageUpdate`
 * returning and the host writing `running`, the file still shows the PREVIOUS
 * run's terminal state, so a second click racing through the file check alone
 * would overwrite a request the host is about to read.
 */
let pending: { id: string; at: number } | null = null

/** Serialises callers: the check-then-write below must not interleave. */
let chain: Promise<unknown> = Promise.resolve()

export function runImageUpdate(input: {
  targets: ImageTarget[]
  actor: string
}): Promise<UpdateOutcome> {
  const outcome = chain.then(() => locked(input))
  chain = outcome.catch(() => undefined)
  return outcome
}

async function locked(input: { targets: ImageTarget[]; actor: string }): Promise<UpdateOutcome> {
  if (input.targets.length === 0 || input.targets.some((t) => t.container === '')) {
    return { ok: false, code: 'refused', reason: 'no container named' }
  }

  // Structural, not factual. Whether a pin exists, may move, or already moves
  // as somebody's lockstep member is checked on the host against the
  // nix-rendered registry that is also the allowlist — see the note below. A
  // container listed twice is neither of those: it is a malformed request, and
  // catching it here costs one comparison instead of a round trip.
  const names = input.targets.map((t) => t.container)
  const dupe = names.find((n, i) => names.indexOf(n) !== i)
  if (dupe !== undefined) {
    return { ok: false, code: 'refused', reason: `${dupe} is in this request twice` }
  }

  // Refuse while one is in flight. The host holds fleet.rebuildLock, so a
  // second request could not corrupt anything — it would queue behind the
  // first and then rebuild against a flake the first one had already changed.
  // Rejecting here is both faster feedback and the correct answer.
  //
  // Deliberately global rather than per-container: the lock is the box's, and
  // two updates in flight means two rebuilds racing whatever their subjects.
  const inFlight = await readImageUpdateStatus()
  if (inFlight.state === 'running') {
    const what =
      inFlight.targets.length > 1
        ? `an update of ${String(inFlight.targets.length)} containers`
        : `an update of ${inFlight.targets[0] ?? inFlight.container}`
    return {
      ok: false,
      code: 'busy',
      reason: `${what} is already running (${inFlight.phase})`,
    }
  }

  if (pending !== null) {
    if (inFlight.id === pending.id) {
      pending = null
    } else if (Date.now() - pending.at < PICKUP_MS) {
      return {
        ok: false,
        code: 'busy',
        reason: 'the previous update request has not been picked up by the host yet',
      }
    } else {
      pending = null
    }
  }

  // Everything about WHICH pins exist, whether this one may move and what its
  // lockstep is gets checked on the host, against the nix-rendered registry
  // that is also the allowlist. Re-checking here would be a second copy of
  // that rule, and the copy the attacker does not have to go through.
  const id = await requestImageUpdate(input)
  pending = { id, at: Date.now() }

  return {
    ok: true,
    id,
    targets: input.targets.map((t) => ({ container: t.container, toTag: t.toTag ?? null })),
  }
}

export type { ImageTarget, ImageUpdateStatus }
