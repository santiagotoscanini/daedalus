import type { Ctx } from '../core/ctx'
import { ceremonyArmed, ceremonyFor, ceremonyRefusal } from '../lib/image-ceremony'
import { imagePins, manualPins } from './contract/domains/images'
import { defineFlow, defineRootGate, type FlowOutcome } from './flow'
import {
  type ImageTarget,
  type ImageUpdateStatus,
  readImageUpdateStatus,
  startImageUpdate,
} from './image-update'

// The one image-update implementation.
//
// Both doors — the Update button's server function (server/updates.ts) and
// the MCP `image.update` tool (host/mcp/server.ts) — call runImageUpdate and
// only translate its outcome into their own response shape: two hand-copied
// bodies are two bodies that drift. The lock and the order of the steps are
// host/flow.ts's; the root helper runs one update at a time.
//
// The typed-name ceremony (lib/image-ceremony.ts) is checked here too, for the
// same reason: a gate each door enforces for itself is a gate one door forgets,
// and a check in the browser is no check at all. A door passes what its caller
// typed — the panel the names typed into its rows, the MCP tool its `confirm` —
// and this decides.
//
// A queued batch is not a third door. It is the same call with more targets,
// which is what keeps "several at once" from becoming a second mechanism with
// its own busy rule and its own way of being wrong.

type Moved = { targets: { container: string; toTag: string | null }[] }

export type UpdateOutcome = FlowOutcome<Moved, 'refused'>

const gate = defineRootGate({
  readStatus: (input: UpdateInput) => readImageUpdateStatus(input.ctx),
  running: (inFlight) => {
    const what =
      inFlight.targets.length > 1
        ? `an update of ${String(inFlight.targets.length)} containers`
        : `an update of ${inFlight.targets[0] ?? 'one container'}`
    return `${what} is already running (${inFlight.phase})`
  },
})

type UpdateInput = {
  ctx: Pick<Ctx, 'controller'>
  targets: ImageTarget[]
  /** The names the caller typed out. A target whose move owes a ceremony must be among them. */
  confirm: readonly string[]
  actor: string
}

/**
 * The refusal for the first target whose ceremony was not typed, or null.
 *
 * A base's pin is looked up under its id, the name the host agent takes it
 * by; whether it may move at all is the agent's to say.
 */
async function untypedCeremony(input: UpdateInput): Promise<string | null> {
  const [pins, manual] = await Promise.all([imagePins(), manualPins()])
  for (const t of input.targets) {
    const base = manual[t.container]
    const pin =
      pins[t.container] ??
      (base?.tag == null
        ? undefined
        : { tag: base.tag, ceremony: base.ceremony, majorCeremony: base.majorCeremony })
    const ceremony = pin === undefined ? null : ceremonyFor(pin, t.toTag)
    if (ceremony === null) continue
    if (!input.confirm.some((typed) => ceremonyArmed(t.container, ceremony, typed))) {
      return ceremonyRefusal(t.container, ceremony)
    }
  }
  return null
}

export const runImageUpdate: (input: UpdateInput) => Promise<UpdateOutcome> = defineFlow<
  UpdateInput,
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
  //
  // The ceremony is the exception: it is not about whether a pin may move but
  // whether this caller read what moving it takes down, and the host has no
  // way to ask.
  prepare: async (input) => {
    const untyped = await untypedCeremony(input)
    if (untyped !== null) return { ok: false, code: 'refused', reason: untyped }
    return {
      ok: true,
      value: {
        targets: input.targets.map((t) => ({ container: t.container, toTag: t.toTag ?? null })),
      },
      publish: async () => {
        const started = await startImageUpdate(input.ctx, {
          targets: input.targets,
          actor: input.actor,
        })
        return started.ok ? started.id : started
      },
    }
  },
})

export type { ImageTarget, ImageUpdateStatus }
