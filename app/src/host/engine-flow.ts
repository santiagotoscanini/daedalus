import { readCommittedSite } from './contract/domains/site-doc'
import {
  type EngineUpdateStatus,
  readEngineUpdateStatus,
  requestEngineUpdate,
} from './engine-update'
import { defineFlow, defineGate, type FlowOutcome } from './flow'

// The one engine-update implementation.
//
// One door today — the button on System › Updates, through its server
// function (server/updates.ts) — and runEngineUpdate is still its own module,
// for host/update-flow.ts's reason: a second door (an MCP tool) would call
// this and only translate the outcome, never copy the body. The lock, the
// pickup window and the order of the steps are host/flow.ts's, shared with it.
//
// There is nothing to check about the input — the request carries only the
// actor — but there is one fact about the box to read before publishing: an
// engine override (site.json `developer.engineOverride`) means the running
// system is built from a local clone rather than from the pinned engine, and
// moving the lock under it would pin a rev nothing is running. The host agent
// refuses the same request for the same reason; refusing here first is a
// file read instead of a round trip through the bridge. The page already
// disables the button with the same explanation (components/engine-update.tsx);
// this is for a request that reaches the flow anyway.

/** Nothing beyond the id: the request has no fields to echo back. */
type Requested = Record<string, never>

export type EngineUpdateOutcome = FlowOutcome<Requested, 'refused'>

const gate = defineGate({
  noun: 'engine update',
  readStatus: readEngineUpdateStatus,
  running: (inFlight) => `an engine update is already running (${inFlight.phase})`,
})

export const runEngineUpdate: (input: { actor: string }) => Promise<EngineUpdateOutcome> =
  defineFlow<{ actor: string }, Requested, 'refused'>(gate, {
    prepare: async (input) => {
      const site = await readCommittedSite()
      const override = site.ok ? site.value.doc.developer.engineOverride : null
      if (override !== null) {
        return {
          ok: false,
          code: 'refused',
          reason: `clear the engine override first — the running system is built from ${override}, not from the pinned engine`,
        }
      }
      return { ok: true, value: {}, publish: () => requestEngineUpdate(input) }
    },
  })

export type { EngineUpdateStatus }
