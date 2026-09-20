import { type Decoder, literal, nullable, obj, optional, str } from '../lib/contract/decode'
import { defineBridge } from './bridge'

// Asking the host to restart the Remote Control server.
//
// The case power-request.ts is oversized for: that bridge's one verb takes
// the whole house offline, and the commonest fault it was reached for — a
// wedged or version-stale claude-remote-control — is a single unit. Rebuilds
// deliberately never restart that unit (platform/claude-rc.nix), and a
// remote session restarting it would kill itself mid-command, so this button
// is the out-of-band hand.
//
// Unlike power, the agent (stacks/daedalus/host/claude-rc.sh) outlives its
// action: `done` and `failed` are both real terminal states, and the
// ordinary status poll covers the whole flow.
//
// ── what it costs, which the armed panel says and this explains ───────────
//
// Every connected session dies with the server, and none of them comes back:
// Remote Control is a bridge for STARTING sessions, not for re-attaching to
// one that lost its process, so the web side can only mint new ones and the
// "restart" claude.ai offers on a dead session starts a fresh conversation.
// What survives is on this box — the transcript is untouched and the row on
// the roster board simply moves from `alive` to `resumable`, where
// `claude --resume` continues it. The environment id is minted per start, so
// the session link changes too.

export type ClaudeRcAction = 'restart'
export type ClaudeRcState = 'idle' | 'running' | 'done' | 'failed'

export type ClaudeRcStatus = {
  id: string | null
  action: ClaudeRcAction | null
  state: ClaudeRcState
  /** What the host is doing or did, in its words. */
  detail: string
  error: string
  startedAt: string | null
  finishedAt: string | null
}

/** The status file the host agent writes; decoding `{}` is the idle status. */
const CLAUDE_RC_STATUS: Decoder<ClaudeRcStatus> = obj({
  id: optional(nullable(str), null),
  action: optional(nullable(literal('restart')), null),
  state: optional(literal('idle', 'running', 'done', 'failed'), 'idle'),
  detail: optional(str, ''),
  error: optional(str, ''),
  startedAt: optional(nullable(str), null),
  finishedAt: optional(nullable(str), null),
})

const bridge = defineBridge<ClaudeRcStatus>({
  requestFile: 'claude-rc-request.json',
  statusFile: 'claude-rc-status.json',
  status: CLAUDE_RC_STATUS,
})

export async function readClaudeRcStatus(): Promise<ClaudeRcStatus> {
  return bridge.readStatus()
}

export async function requestClaudeRcRestart(input: { actor: string }): Promise<string> {
  return bridge.request({ action: 'restart', actor: input.actor })
}
