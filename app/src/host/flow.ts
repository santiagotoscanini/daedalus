// The skeleton every root verb that must refuse a second request while the
// host is busy shares: a promise chain and a `running` check. Its
// arrangements are host/apply-flow.ts, host/update-flow.ts (both reachable
// from a button and an MCP tool), host/engine-flow.ts,
// host/claude-code-flow.ts and host/version-update.ts (a button each). The
// steps are
//
//   check the input → refuse if the host is busy → prepare → start
//
// in that order, under one lock. The order is part of the contract: a
// malformed request is refused as malformed even while the host is busy, and
// nothing is prepared (the registry read, the site render) for a request that
// is about to be refused as busy. The start is the root helper's
// (host/root-verb.ts): answered once the verb's unit has started, and refused
// by the helper while another run of the verb is under way — so no request
// can sit unclaimed, and the helper is the last word on "one at a time".
//
// WHAT IS NOT HERE, on purpose.
//
// Who may call. The button's server function is an `adminFn` (server/fn.ts,
// which runs core/authz `assertAdmin()`), the MCP tool asks
// `assertMachineActor(proof)` — two different questions with one answer, the
// actor, which every flow takes as input. Same argument as
// core/builds/actions.ts: a flow that read the ambient request could not be
// called from /mcp, which has none.
//
// Waiting for the outcome. No flow waits: each returns the run's id the
// moment it has started and the caller polls the status file (the button's
// status query; the MCP tool hands its caller the id). A rebuild outlives any
// request that could wait on it.
//
// The gate and the flow are two things because Apply has two flows behind ONE
// lock: `runApply` and `runSecretApply` start the same verb, so they must
// share a chain, and `secretApplyBlocker` / `applyPreview` ask the gate its
// question without taking it.

export type FlowRefusal<C extends string> = { ok: false; code: C; reason: string }

/**
 * lib/result.ts's shape, flat: the started run's `id` and the flow's own
 * fields on success, a `code` beside the `reason` on failure. Flat because a
 * machine caller branches on `code` (the MCP tool prefixes it to the refusal;
 * the buttons show only the reason) — see lib/result.ts for why that is not a
 * nested `reason.code`.
 * `busy` is the gate's own code (and the helper's, for a run already under
 * way) and every flow can answer it; `unavailable` is a start that could not
 * be asked (no controller, no helper).
 */
export type FlowOutcome<T extends object, C extends string = never> =
  | ({ ok: true; id: string } & T)
  | FlowRefusal<C | 'busy' | 'unavailable'>

export type FlowGate<I> = {
  /**
   * Why a new request may not start now, or null when it may: the verb's
   * status says a run is under way. Asked of the flow's input, which carries
   * the Ctx the status is read with. A read.
   */
  blocked: (input: I) => Promise<FlowRefusal<'busy'> | null>
  /** Run `work` after every earlier caller's: check-then-start must not interleave. */
  serialised: <O>(work: () => Promise<O>) => Promise<O>
}

export function defineGate<I, S extends { state: string }>(opts: {
  readStatus: (input: I) => Promise<S>
  /** The refusal's sentence for a status whose state is `running`. */
  running: (status: S) => string
}): FlowGate<I> {
  let chain: Promise<unknown> = Promise.resolve()
  return {
    async blocked(input) {
      const inFlight = await opts.readStatus(input)
      return inFlight.state === 'running'
        ? { ok: false, code: 'busy', reason: opts.running(inFlight) }
        : null
    },
    serialised(work) {
      const outcome = chain.then(work)
      chain = outcome.catch(() => undefined)
      return outcome
    },
  }
}

/**
 * What `prepare` hands back: a refusal, or the start and what to report beside
 * its id. The start may still be refused by the helper (a run already under
 * way) or not be asked at all — that refusal is the flow's answer.
 */
export type FlowPlan<T extends object, C extends string> =
  | FlowRefusal<C>
  | {
      ok: true
      publish: () => Promise<string | FlowRefusal<'busy' | 'unavailable'>>
      value: T
    }

export function defineFlow<I, T extends object, C extends string = never>(
  gate: FlowGate<I>,
  opts: {
    /**
     * Refusals that need nothing but the input. Asked BEFORE the busy check, so
     * a malformed request is told so whatever the host is doing.
     */
    check?: (input: I) => FlowRefusal<C> | null
    /**
     * Everything that reads the box, asked only once the gate is open.
     * `publish` is the start and returns the run's id; it is a thunk so a
     * refusal here provably started nothing.
     */
    prepare: (input: I) => Promise<FlowPlan<T, C>>
  },
): (input: I) => Promise<FlowOutcome<T, C>> {
  return (input) =>
    gate.serialised(async (): Promise<FlowOutcome<T, C>> => {
      const malformed = opts.check?.(input) ?? null
      if (malformed !== null) return malformed

      const busy = await gate.blocked(input)
      if (busy !== null) return busy

      const plan = await opts.prepare(input)
      if (!plan.ok) return plan

      const id = await plan.publish()
      if (typeof id !== 'string') return id
      return { ok: true, id, ...plan.value }
    })
}
