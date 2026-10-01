import type { Ctx } from '../core/ctx'
import { readClaudeCodeUpdateStatus, startClaudeCodeUpdate } from './claude-code-update'
import { readCommittedSite } from './contract/domains/site-doc'
import { readEngineUpdateStatus } from './engine-update'
import { defineFlow, defineGate, type FlowOutcome } from './flow'

// The one claude-code-update implementation, in host/engine-flow.ts's shape.
//
// Two facts about the box are read before starting:
//
//   - An engine override means the running system is built from a local tree
//     rather than the pinned engine, so moving pins under it commits a rev
//     nothing runs. Same refusal, same sentence, as the engine flow's; the
//     host agent (nix/stacks/daedalus/host/claude-code-update.sh) refuses it
//     again, and that is the check that holds.
//   - An engine update already running. This verb ENDS by asking for one, so
//     starting while the engine verb has the rebuild lock would queue a
//     second request behind a build that is about to move the same lock.

/** Nothing beyond the id: the request has no fields to echo back. */
type Requested = Record<string, never>

export type ClaudeCodeUpdateOutcome = FlowOutcome<Requested, 'refused'>

type Input = { ctx: Pick<Ctx, 'controller'>; actor: string }

const gate = defineGate({
  readStatus: (input: Input) => readClaudeCodeUpdateStatus(input.ctx),
  running: (inFlight) => `a Claude Code pin is already running (${inFlight.phase})`,
})

export const runClaudeCodeUpdate: (input: Input) => Promise<ClaudeCodeUpdateOutcome> = defineFlow<
  Input,
  Requested,
  'refused'
>(gate, {
  prepare: async (input) => {
    const site = await readCommittedSite()
    if (site.ok && site.value.doc.developer.engineOverride) {
      return {
        ok: false,
        code: 'refused',
        reason:
          'clear the engine override first — the running system is built from the engine clone, not from the pinned engine',
      }
    }
    const engine = await readEngineUpdateStatus(input.ctx)
    if (engine.state === 'running') {
      return {
        ok: false,
        code: 'refused',
        reason: `an engine update is already running (${engine.phase}) — this pin ends by asking for one, so wait for it to finish`,
      }
    }
    return {
      ok: true,
      value: {},
      publish: async () => {
        const started = await startClaudeCodeUpdate(input.ctx, { actor: input.actor })
        return started.ok ? started.id : started
      },
    }
  },
})
