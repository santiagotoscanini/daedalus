import { type Decoder, literal, nullable, obj, optional, str } from '../lib/contract/decode'
import { defineBridge } from './bridge'

// The app half of moving this box's Claude Code pin. It writes one file and
// reads another.
//
// The CLI here is a nix package sealed with DISABLE_UPDATES
// (platform/claude-code/claude-code.nix says why), so `claude update` is not
// a path and a flake bump is the only one. The bump starts in the ENGINE —
// its `nix/platform/claude-code/manifest.json` is what the packaged
// expression takes as its manifest — and the host agent does exactly that
// half: fetch the current release, verify the detached signature against
// Anthropic's published key, commit the manifest into the engine clone, push
// it, and then publish an `engine-request.json` so the proven engine verb
// (host/engine-update.ts) carries out the rebuild.
//
// That handoff is why `state: 'done'` here does not mean the new CLI is
// installed — it means it is PINNED and the engine update has been asked for.
// The page follows the engine status from there, and the box's own snapshot
// ("what the flake holds") is the answer that settles it.
//
// No payload and nothing to choose: the release to move to is whatever
// upstream calls latest, which is the host's answer, published as `to`.

export type ClaudeCodeUpdateState = 'idle' | 'running' | 'done' | 'failed'

export type ClaudeCodeUpdateStatus = {
  id: string | null
  state: ClaudeCodeUpdateState
  phase: string
  error: string
  /** The version the engine's manifest pinned when the run started. */
  from: string
  /** The version upstream calls latest. Empty until resolved; equal to `from` on a no-op. */
  to: string
  startedAt: string | null
  finishedAt: string | null
  /** The manifest commit in the engine, short. Empty until committed. */
  commit: string | null
}

/** The status file the host agent writes; decoding `{}` is the idle status. */
const CLAUDE_CODE_STATUS: Decoder<ClaudeCodeUpdateStatus> = obj({
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

const bridge = defineBridge<ClaudeCodeUpdateStatus>({
  requestFile: 'claude-code-request.json',
  statusFile: 'claude-code-status.json',
  status: CLAUDE_CODE_STATUS,
})

/**
 * How long a `running` status may go unrefreshed before it is a corpse.
 *
 * Far shorter than the engine's hour, because nothing here builds: three
 * small fetches, a signature check and a push. The unit's own
 * TimeoutStartSec is 10 minutes (stacks/daedalus/claude-code-update.nix) and
 * this is that plus slack; the two move together.
 */
const RUNNING_MAX_MS = 12 * 60_000

/** The status, with a dead run reported as dead. */
export async function readClaudeCodeUpdateStatus(): Promise<ClaudeCodeUpdateStatus> {
  const s = await bridge.readStatus()
  if (s.state !== 'running') return s

  const last = Date.parse(s.finishedAt ?? '')
  if (Number.isFinite(last) && Date.now() - last < RUNNING_MAX_MS) return s

  return {
    ...s,
    state: 'failed',
    error:
      `The host agent stopped writing during "${s.phase}" and did not report a result. ` +
      'Check `journalctl -u daedalus-claude-code-update` and `git log` in the engine clone ' +
      'before retrying.',
  }
}

/** Publish a pin request. Nothing to choose: upstream's latest, or nothing. */
export async function requestClaudeCodeUpdate(input: { actor: string }): Promise<string> {
  return bridge.request({ actor: input.actor })
}
