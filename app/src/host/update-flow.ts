import { defineFlow, defineGate, type FlowOutcome } from './flow'
import {
  type ImageTarget,
  type ImageUpdateStatus,
  readImageUpdateStatus,
  requestImageUpdate,
} from './image-update'

// The one image-update implementation.
//
// Both doors — the Update button's server function (server/updates.ts) and
// the MCP `image.update` tool (host/mcp/server.ts) — call runImageUpdate and
// only translate its outcome into their own response shape: two hand-copied
// bodies are two bodies that drift. The lock, the pickup window and the order
// of the steps are host/flow.ts's, shared with Apply and the engine update.
//
// A queued batch is not a third door. It is the same call with more targets,
// which is what keeps "several at once" from becoming a second mechanism with
// its own busy rule and its own way of being wrong.

type Moved = { targets: { container: string; toTag: string | null }[] }

export type UpdateOutcome = FlowOutcome<Moved, 'refused'>

const gate = defineGate({
  noun: 'update',
  readStatus: readImageUpdateStatus,
  running: (inFlight) => {
    const what =
      inFlight.targets.length > 1
        ? `an update of ${String(inFlight.targets.length)} containers`
        : `an update of ${inFlight.targets[0] ?? 'one container'}`
    return `${what} is already running (${inFlight.phase})`
  },
})

export const runImageUpdate: (input: {
  targets: ImageTarget[]
  actor: string
}) => Promise<UpdateOutcome> = defineFlow<
  { targets: ImageTarget[]; actor: string },
  Moved,
  'refused'
>(gate, {
  check: (input) => {
    if (input.targets.length === 0 || input.targets.some((t) => t.container === '')) {
      return { ok: false, code: 'refused', reason: 'no container named' }
    }

    // Structural, not factual (the facts are the host's — see `prepare`). A
    // container listed twice is a malformed request, and catching it here
    // costs one comparison instead of a round trip; the host refuses it too.
    const names = input.targets.map((t) => t.container)
    const dupe = names.find((n, i) => names.indexOf(n) !== i)
    if (dupe !== undefined) {
      return { ok: false, code: 'refused', reason: `${dupe} is in this request twice` }
    }
    return null
  },

  // Everything about WHICH pins exist, whether this one may move and what its
  // lockstep is gets checked on the host, against the nix-rendered registry
  // that is also the allowlist. Re-checking here would be a second copy of
  // that rule, and the copy the attacker does not have to go through.
  prepare: async (input) => ({
    ok: true,
    value: {
      targets: input.targets.map((t) => ({ container: t.container, toTag: t.toTag ?? null })),
    },
    publish: () => requestImageUpdate(input),
  }),
})

export type { ImageTarget, ImageUpdateStatus }
