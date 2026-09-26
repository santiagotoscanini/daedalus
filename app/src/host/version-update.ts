import {
  arrayOf,
  bool,
  type Decoder,
  literal,
  nullable,
  obj,
  optional,
  str,
} from '../lib/contract/decode'
import { defineBridge } from './bridge'
import { defineFlow, defineGate, type FlowOutcome } from './flow'

// The app half of a version update: one request file, one status file.
//
// A stack that pins its version as plain strings (a game server's release and
// build) declares them in fleet.versionPins; the host agent rewrites them,
// commits, builds, snapshots the stack's dataset, switches, runs the stack's
// verifier, and on failure after the switch rolls the dataset and the commit
// back (stacks/daedalus/host/version-update.sh). What crosses the bridge is a
// target and the new values — which fields exist, what they may look like and
// where they live is the host's registry, which is also the allowlist.

type VersionUpdateState = 'idle' | 'running' | 'done' | 'failed'

type VersionMove = { field: string; binding: string; from: string; to: string }

export type VersionUpdateStatus = {
  id: string | null
  target: string
  state: VersionUpdateState
  phase: string
  error: string
  moves: VersionMove[]
  /** The pre-update snapshot of the stack's dataset, once taken. */
  snapshot: string
  /** True when a failure was undone — commit reverted, dataset restored. */
  rolledBack: boolean
  startedAt: string | null
  finishedAt: string | null
  commit: string | null
}

const STATUS: Decoder<VersionUpdateStatus> = obj({
  id: optional(nullable(str), null),
  target: optional(str, ''),
  state: optional(literal('idle', 'running', 'done', 'failed'), 'idle'),
  phase: optional(str, ''),
  error: optional(str, ''),
  moves: optional(arrayOf(obj({ field: str, binding: str, from: str, to: str })), []),
  snapshot: optional(str, ''),
  rolledBack: optional(bool, false),
  startedAt: optional(nullable(str), null),
  finishedAt: optional(nullable(str), null),
  commit: optional(nullable(str), null),
})

const bridge = defineBridge<VersionUpdateStatus>({
  requestFile: 'version-request.json',
  statusFile: 'version-status.json',
  status: STATUS,
})

/** daedalus-version-update's TimeoutStartSec (60 min) plus slack; they move together. */
const RUNNING_MAX_MS = 65 * 60_000

/** The status, with a run that stopped writing reported as dead (host/image-update.ts). */
export async function readVersionUpdateStatus(): Promise<VersionUpdateStatus> {
  const s = await bridge.readStatus()
  if (s.state !== 'running') return s
  const last = Date.parse(s.finishedAt ?? '')
  if (Number.isFinite(last) && Date.now() - last < RUNNING_MAX_MS) return s
  return {
    ...s,
    state: 'failed',
    error:
      `The host agent stopped writing during "${s.phase}" and did not report a result. ` +
      'Check `journalctl -u daedalus-version-update`, `git log` in the configuration checkout' +
      (s.snapshot === '' ? '' : `, and the pre-update snapshot ${s.snapshot}`) +
      ' before retrying.',
  }
}

const gate = defineGate({
  noun: 'version update',
  readStatus: readVersionUpdateStatus,
  running: (s) => `an update of ${s.target} is already running (${s.phase})`,
})

type Input = { target: string; values: Record<string, string>; actor: string }

/**
 * The one version-update implementation; the button's server function is its
 * door. Structure is checked here; whether the target and fields exist and
 * the values fit is the host's registry to say.
 */
export const runVersionUpdate: (
  input: Input,
) => Promise<FlowOutcome<{ target: string }, 'refused'>> = defineFlow<
  Input,
  { target: string },
  'refused'
>(gate, {
  check: (input) => {
    if (!/^[a-z0-9-]+$/.test(input.target)) {
      return { ok: false, code: 'refused', reason: 'no target named' }
    }
    const entries = Object.entries(input.values)
    if (entries.length === 0) return { ok: false, code: 'refused', reason: 'no values to move' }
    const bad = entries.find(([k, v]) => !/^[a-z]+$/.test(k) || !/^[A-Za-z0-9._+-]{1,64}$/.test(v))
    if (bad !== undefined) {
      return { ok: false, code: 'refused', reason: `${bad[0]} = ${bad[1]} is not a valid pin` }
    }
    return null
  },
  prepare: async (input) => ({
    ok: true,
    value: { target: input.target },
    publish: () =>
      bridge.request({ target: input.target, values: input.values, actor: input.actor }),
  }),
})
