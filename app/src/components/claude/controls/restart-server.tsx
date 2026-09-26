// The Remote control board's second verb: restart the server, armed first
// because every connected session dies with it.

// Types ONLY. claude-rc-request imports the bridge, which reads node:fs, so a
// value import would put that in the browser bundle — which is why its idle
// shape is restated below rather than imported.
import type { ClaudeRcStatus } from '../../../host/claude-rc-request'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import { fetchClaudeRcStatusFn, requestClaudeRestartFn } from '../../../server/claude'
import { GHOST_BTN } from '../../apps/shared'
import { usePolledStatus } from '../../status'
import { MONO } from '../../tokens'
import { Button } from '../../ui/button'
import { useArmed } from '../../use-armed'
import {
  RC_ARM_MS,
  RESTART,
  RESTART_ARMED,
  RESTART_COST,
  RESTART_NOTE,
  RESTART_STATE,
} from '../shared'

const RC_IDLE: ClaudeRcStatus = {
  id: null,
  action: null,
  state: 'idle',
  detail: '',
  error: '',
  startedAt: null,
  finishedAt: null,
}

/**
 * Restart the Remote Control server.
 *
 * The out-of-band hand for the unit nothing else may touch: rebuilds
 * deliberately never restart it (platform/claude-rc.nix), and a remote
 * session running `systemctl restart` on it kills itself mid-command — so
 * recovering a wedged server, or landing the build a rebuild left pending,
 * is either this button or a reboot of the whole box.
 *
 * Two steps like the box restart, but the cost spelled out at arm time is a
 * different one: sessions, not the house. And unlike its big sibling this
 * flow settles normally — the host agent outlives the restart and writes a
 * real done/failed, so the ordinary status poll covers it.
 */
export function RestartServerControl({ live }: { live: number }) {
  const [armed, arm, disarm] = useArmed(RC_ARM_MS)
  const { status, running, refusal, start } = usePolledStatus<ClaudeRcStatus>({
    initial: RC_IDLE,
    fetch: () => fetchClaudeRcStatusFn(),
    claimTimeoutMs: 30_000,
  })

  if (running) {
    return (
      <div className={RESTART}>
        <p className={RESTART_STATE}>Restarting the server…</p>
      </div>
    )
  }

  if (armed) {
    return (
      <div className={cn(RESTART, RESTART_ARMED)}>
        <p className={RESTART_COST}>
          {live === 0
            ? 'Nothing is connected, so this costs nothing right now.'
            : live === 1
              ? 'The one connected session dies with the server.'
              : `All ${num(live)} connected sessions die with the server.`}{' '}
          Dead sessions cannot be picked back up from claude.ai — the server only bridges new ones;
          their transcripts survive on this box and <span className={MONO}>claude --resume</span> at
          the console is the way back in. The environment id is minted per start, so the session
          link above becomes a new one. The box itself is untouched.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              disarm()
              start(async () => ({ ok: true, value: (await requestClaudeRestartFn()).id }))
            }}
          >
            Confirm restart
          </Button>
          <Button type="button" variant="outline" size="sm" className={GHOST_BTN} onClick={disarm}>
            Cancel
          </Button>
          <span className={RESTART_NOTE}>disarms on its own in {RC_ARM_MS / 1000}s</span>
        </div>
      </div>
    )
  }

  return (
    <div className={RESTART}>
      {status.state === 'done' && (
        <p className={cn(RESTART_STATE, 'text-success')}>
          {status.detail || 'The server restarted.'} The boards above catch up within a minute — the
          snapshot is on a timer.
        </p>
      )}
      {refusal !== null && <p className={cn(RESTART_STATE, 'text-danger')}>{refusal}</p>}
      {refusal === null && status.state === 'failed' && (
        <p className={cn(RESTART_STATE, 'text-danger')}>{status.error}</p>
      )}
      <Button type="button" variant="outline" size="sm" className={GHOST_BTN} onClick={arm}>
        Restart the server
      </Button>
    </div>
  )
}
