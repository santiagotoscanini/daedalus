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

const bridge = defineBridge<ClaudeRcStatus>({
  requestFile: 'claude-rc-request.json',
  statusFile: 'claude-rc-status.json',
  idle: {
    id: null,
    action: null,
    state: 'idle',
    detail: '',
    error: '',
    startedAt: null,
    finishedAt: null,
  },
})

export async function readClaudeRcStatus(): Promise<ClaudeRcStatus> {
  return bridge.readStatus()
}

export async function requestClaudeRcRestart(input: { actor: string }): Promise<string> {
  return bridge.request({ action: 'restart', actor: input.actor })
}
