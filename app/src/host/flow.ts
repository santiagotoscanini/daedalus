import type { BridgeStatus } from './bridge'

// What a bridge verb with more than one door has in common.
//
// Apply and image-update are each reachable from a button (its server
// function) and an MCP tool, and each is one implementation (host/apply-flow.ts,
// host/update-flow.ts) the doors adapt. Those two implementations were
// themselves the same skeleton written twice — a promise chain, a `pending`
// request, a pickup window, a `running` check — and this is that skeleton once:
//
//   check the input → refuse if the host is busy → prepare → publish → remember
//
// in that order, under one lock. The order is part of the contract: a
// malformed request is refused as malformed even while the host is busy, and
// nothing is prepared (the registry read, the site render) for a request that
// is about to be refused as busy.
//
// WHAT IS NOT HERE, on purpose.
//
// Who may call. The button asks core/authz `assertAdmin()`, the MCP tool
// `assertMachineActor(proof)` — two different questions with one answer, the actor, which every flow takes as
// input. Same argument as core/builds/actions.ts: a flow that read the ambient
// request could not be called from /mcp, which has none.
//
// Waiting for the outcome. Neither flow waits: both return the request's id
// the moment it is published and every door's caller polls the status file
// (the button's status query; the MCP tool hands its caller the id). A rebuild outlives any
// request that could wait on it.
//
// The gate and the flow are two things because Apply has two flows behind ONE
// lock: `runApply` and `runSecretApply` publish to the same request file, so
// they must share a chain and a `pending`, and `secretApplyBlocker` /
// `applyPreview` ask the gate its question without taking it.

export type FlowRefusal<C extends string> = { ok: false; code: C; reason: string }

/**
 * lib/result.ts's shape, flat: the published request's `id` and the flow's own
 * fields on success, a `code` beside the `reason` on failure. Flat because the
 * doors branch on `code` (the route maps it to an HTTP status, the MCP tool
 * prefixes it) — see lib/result.ts for why that is not a nested `reason.code`.
 * `busy` is the gate's own code and every flow can answer it.
 */
export type FlowOutcome<T extends object, C extends string = never> =
  | ({ ok: true; id: string } & T)
  | FlowRefusal<C | 'busy'>

/**
 * How long a published request may sit unclaimed before a new one is allowed
 * to overwrite it. The path unit normally reacts within a second or two; a
 * request still foreign to the status file after two minutes means the host
 * agent is not coming for it, and refusing forever would wedge the button
 * until a container restart.
 */
export const PICKUP_MS = 120_000

export type FlowGate = {
  /**
   * Why a new request may not be published now, or null when it may. A read,
   * apart from forgetting a `pending` the host has acknowledged or abandoned.
   */
  blocked: () => Promise<FlowRefusal<'busy'> | null>
  /** Run `work` after every earlier caller's: check-then-write must not interleave. */
  serialised: <O>(work: () => Promise<O>) => Promise<O>
  /** Record a request just published, which opens its pickup window. */
  published: (id: string) => void
}

export function defineGate<S extends BridgeStatus>(opts: {
  /** The verb as the refusal names it: "the previous <noun> request has not been picked up…". */
  noun: string
  readStatus: () => Promise<S>
  /** The refusal's sentence for a status whose state is `running`. */
  running: (status: S) => string
}): FlowGate {
  // The last request this process published and has not yet seen the host
  // acknowledge in the status file. This closes the window the file cannot:
  // between the request being written and the host writing `running`, the file
  // still shows the PREVIOUS run's terminal state, so a second caller racing
  // through the file check alone would replace a request (and for Apply, the
  // bytes of apps.json) under a rebuild that is about to read it.
  //
  // Process-local on purpose: this container is the only writer into /apply,
  // and a single node process serves every door.
  let pending: { id: string; at: number } | null = null
  let chain: Promise<unknown> = Promise.resolve()

  return {
    async blocked() {
      // Refuse while one is in flight. The host script holds fleet.rebuildLock,
      // so a second request could not corrupt anything — it would queue behind
      // the first and then act on a snapshot taken BEFORE the first one landed.
      // Rejecting here is both faster feedback and the correct answer.
      //
      // Deliberately global per verb rather than per subject: the lock is the
      // box's, and two in flight means two rebuilds racing whatever they name.
      const inFlight = await opts.readStatus()
      if (inFlight.state === 'running') {
        return { ok: false, code: 'busy', reason: opts.running(inFlight) }
      }

      if (pending !== null) {
        if (inFlight.id === pending.id) {
          // The host has caught up: the status file now speaks for our
          // request, and the `running` check above is the guard again.
          pending = null
        } else if (Date.now() - pending.at < PICKUP_MS) {
          return {
            ok: false,
            code: 'busy',
            reason: `the previous ${opts.noun} request has not been picked up by the host yet`,
          }
        } else {
          pending = null
        }
      }
      return null
    },

    serialised(work) {
      const outcome = chain.then(work)
      chain = outcome.catch(() => undefined)
      return outcome
    },

    published(id) {
      pending = { id, at: Date.now() }
    },
  }
}

/** What `prepare` hands back: a refusal, or the write and what to report beside its id. */
export type FlowPlan<T extends object, C extends string> =
  | FlowRefusal<C>
  | { ok: true; publish: () => Promise<string>; value: T }

export function defineFlow<I, T extends object, C extends string = never>(
  gate: FlowGate,
  opts: {
    /**
     * Refusals that need nothing but the input. Asked BEFORE the busy check, so
     * a malformed request is told so whatever the host is doing.
     */
    check?: (input: I) => FlowRefusal<C> | null
    /**
     * Everything that reads the box, asked only once the gate is open.
     * `publish` is the bridge write and returns the request's id; it is a
     * thunk so a refusal here provably wrote nothing.
     */
    prepare: (input: I) => Promise<FlowPlan<T, C>>
  },
): (input: I) => Promise<FlowOutcome<T, C>> {
  return (input) =>
    gate.serialised(async (): Promise<FlowOutcome<T, C>> => {
      const malformed = opts.check?.(input) ?? null
      if (malformed !== null) return malformed

      const busy = await gate.blocked()
      if (busy !== null) return busy

      const plan = await opts.prepare(input)
      if (!plan.ok) return plan

      const id = await plan.publish()
      gate.published(id)
      return { ok: true, id, ...plan.value }
    })
}
