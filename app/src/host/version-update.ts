import type { Ctx } from '../core/ctx'
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
import { defineFlow, defineRootGate, type FlowOutcome } from './flow'
import { defineRootVerb } from './root-verb'

// The app half of a version update: the root helper's `version-update` verb
// (host/root-verb.ts has the mechanics).
//
// A stack that pins its version as plain strings (a game server's release and
// build) declares them in fleet.versionPins; the host agent rewrites them,
// commits, builds, snapshots the stack's dataset (when it names one),
// switches, runs the stack's verifier, and on failure after the switch rolls
// the dataset and the commit back (nix/stacks/daedalus/host/version-update.sh).
// What crosses is a target and the new values, as the payload — which fields
// exist, what they may look like and where they live is the host's registry,
// which is also the allowlist.

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

const verb = defineRootVerb<VersionUpdateStatus>({
  verb: 'version-update',
  status: STATUS,
  ended: (s) =>
    `The host agent ended during "${s.phase}" without reporting a result. ` +
    "Check `journalctl -u 'daedalus-version-update@*'`, `git log` in the configuration checkout" +
    (s.snapshot === '' ? '' : `, and the pre-update snapshot ${s.snapshot}`) +
    ' before retrying.',
})

/** The status, with a run that ended without its last word reported as dead (host/root-verb.ts). */
export const readVersionUpdateStatus = (
  ctx: Pick<Ctx, 'controller'>,
): Promise<VersionUpdateStatus> => verb.readStatus(ctx)

type Input = {
  ctx: Pick<Ctx, 'controller'>
  target: string
  values: Record<string, string>
  actor: string
}

const gate = defineRootGate({
  readStatus: (input: Input) => readVersionUpdateStatus(input.ctx),
  running: (s) => `an update of ${s.target} is already running (${s.phase})`,
})

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
    publish: async () => {
      const started = await verb.start(
        input.ctx,
        JSON.stringify({ target: input.target, values: input.values, actor: input.actor }),
      )
      return started.ok ? started.id : started
    },
  }),
})
