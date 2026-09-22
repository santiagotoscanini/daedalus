import { type Decoder, literal, nullable, obj, optional, str } from '../lib/contract/decode'
import { defineBridge } from './bridge'

// The app half of an engine update. It writes one file and reads another.
//
// The engine is a flake input of the configuration — `daedalus`, pinned by
// rev in its flake.lock — so "update daedalus" is the same act as moving an
// image pin (host/image-update.ts), aimed at the lock instead of a `.nix`
// file: resolve what "latest" is, move the pin, build, switch, verify, revert
// if the control plane does not come back, push. Everything privileged is the
// host's: a systemd.path unit watches engine-request.json and starts
// daedalus-engine-update.service (stacks/daedalus/host/engine-update.sh),
// which also does the one thing this container must never do — fast-forward
// the engine clone that this very process is running out of.
//
// No payload and nothing to choose. An image update names a container and a
// tag; the engine has one input and one branch (`main`, always), so the
// request carries only the actor. What "latest" resolves to is the host's
// answer, published in the status as `to`.

export type EngineUpdateState = 'idle' | 'running' | 'done' | 'failed'

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

const bridge = defineBridge<EngineUpdateStatus>({
  requestFile: 'engine-request.json',
  statusFile: 'engine-status.json',
  status: ENGINE_STATUS,
})

export const IDLE_ENGINE_UPDATE: EngineUpdateStatus = bridge.idle

/**
 * How long a `running` status may go unrefreshed before it is a corpse.
 *
 * The same rule as host/image-update.ts, for the same reason: a run killed
 * without writing its terminal state would otherwise say "running" forever,
 * and the flow refuses to start while one is running. The host rewrites the
 * whole file — `finishedAt` included — at every phase, so that field is
 * really "last written". The unit's own TimeoutStartSec is 60 minutes
 * (engine-update.nix); five minutes of slack keeps a slow switch from being
 * declared dead while it is still going. The two move together.
 */
const RUNNING_MAX_MS = 65 * 60_000

/** The status, with a dead run reported as dead. */
export async function readEngineUpdateStatus(): Promise<EngineUpdateStatus> {
  const s = await bridge.readStatus()
  if (s.state !== 'running') return s

  const last = Date.parse(s.finishedAt ?? '')
  if (Number.isFinite(last) && Date.now() - last < RUNNING_MAX_MS) return s

  return {
    ...s,
    state: 'failed',
    error:
      `The host agent stopped writing during "${s.phase}" and did not report a result. ` +
      'The rebuild may or may not have completed — check `journalctl -u daedalus-engine-update` ' +
      'and `git log` in the configuration checkout before retrying.',
  }
}

/** Publish an update request. Nothing to choose: one input, one branch. */
export async function requestEngineUpdate(input: { actor: string }): Promise<string> {
  return bridge.request({ actor: input.actor })
}
