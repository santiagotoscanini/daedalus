import {
  type ClaudeCodeUpdateStatus,
  readClaudeCodeUpdateStatus,
  requestClaudeCodeUpdate,
} from './claude-code-update'
import { readCommittedSite } from './contract/domains/site-doc'
import { readEngineUpdateStatus } from './engine-update'
import { defineFlow, defineGate, type FlowOutcome } from './flow'

// The one claude-code-update implementation, in host/engine-flow.ts's shape.
//
// Two facts about the box are read before publishing, and both are cheaper
// here than a round trip through the bridge — the host agent checks each of
// them again, and those are the checks that hold:
//
//   - An engine override means the running system is built from a local tree
//     rather than the pinned engine, so moving pins under it commits a rev
//     nothing runs. Same refusal, same sentence, as the engine flow's.
//   - An engine update already running. This verb ENDS by asking for one, so
//     starting while the engine verb has the rebuild lock would queue a
//     second request behind a build that is about to move the same lock.
//     Refusing up front says that in a sentence rather than as a failure
//     eight minutes later.

/** Nothing beyond the id: the request has no fields to echo back. */
type Requested = Record<string, never>

export type ClaudeCodeUpdateOutcome = FlowOutcome<Requested, 'refused'>

const gate = defineGate({
  noun: 'Claude Code pin',
  readStatus: readClaudeCodeUpdateStatus,
  running: (inFlight) => `a Claude Code pin is already running (${inFlight.phase})`,
})

export const runClaudeCodeUpdate: (input: { actor: string }) => Promise<ClaudeCodeUpdateOutcome> =
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
      const engine = await readEngineUpdateStatus()
      if (engine.state === 'running') {
        return {
          ok: false,
          code: 'refused',
          reason: `an engine update is already running (${engine.phase}) — this pin ends by asking for one, so wait for it to finish`,
        }
      }
      return { ok: true, value: {}, publish: () => requestClaudeCodeUpdate(input) }
    },
  })

export type { ClaudeCodeUpdateStatus }
