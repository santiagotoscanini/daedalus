import type { Ctx } from '../core/ctx'
import { type Decoder, literal, nullable, obj, optional, str } from '../lib/contract/decode'
import { defineRootVerb } from './root-verb'

// The app half of an engine update: the root helper's `engine-update` verb
// (host/root-verb.ts has the mechanics).
//
// The engine is a flake input of the configuration — `daedalus`, pinned by
// rev in its flake.lock — so "update daedalus" is the same act as moving an
// image pin (host/image-update.ts), aimed at the lock instead of a `.nix`
// file: resolve what "latest" is, move the pin, build, switch, verify, revert
// if the control plane does not come back, push. Everything privileged is the
// host's: `daedalus-engine-update@<run>`
// (nix/stacks/daedalus/host/engine-update.sh), which also does the one thing
// this container must never do — fast-forward the engine clone that this very
// process is running out of.
//
// Nothing to choose. An image update names a container and a tag; the engine
// has one input and one branch (`main`, always), so the payload carries only
// the actor. What "latest" resolves to is the host's answer, published in the
// status as `to`.

type EngineUpdateState = 'idle' | 'running' | 'done' | 'failed'

export type EngineUpdateStatus = {
  id: string | null
  state: EngineUpdateState
  phase: string
  error: string
  /** The rev the lock held when the run started. Empty until the host read it. */
  from: string
  /** The rev the lock moved to. Empty until resolved; equal to `from` on a no-op. */
  to: string
  startedAt: string | null
  finishedAt: string | null
  /** The lock-bump commit, short. Empty until committed, and after a revert. */
  commit: string | null
}

/** The status file the host agent writes; decoding `{}` is the idle status. */
const ENGINE_STATUS: Decoder<EngineUpdateStatus> = obj({
  id: optional(nullable(str), null),
  state: optional(literal('idle', 'running', 'done', 'failed'), 'idle'),
  phase: optional(str, ''),
  error: optional(str, ''),
  from: optional(str, ''),
  to: optional(str, ''),
  startedAt: optional(nullable(str), null),
  finishedAt: optional(nullable(str), null),
  commit: optional(nullable(str), null),
})

const verb = defineRootVerb<EngineUpdateStatus>({
  verb: 'engine-update',
  status: ENGINE_STATUS,
  ended: (s) =>
    `The host agent ended during "${s.phase}" without reporting a result. ` +
    "The rebuild may or may not have completed — check `journalctl -u 'daedalus-engine-update@*'` " +
    'and `git log` in the configuration checkout before retrying.',
})

/** The status, with a run that ended without its last word reported as dead (host/root-verb.ts). */
export const readEngineUpdateStatus = (ctx: Pick<Ctx, 'controller'>): Promise<EngineUpdateStatus> =>
  verb.readStatus(ctx)

/** Start an update. Nothing to choose: one input, one branch. */
export const startEngineUpdate = (ctx: Pick<Ctx, 'controller'>, input: { actor: string }) =>
  verb.start(ctx, JSON.stringify({ actor: input.actor }))
