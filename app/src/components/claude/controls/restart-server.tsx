// The Remote control board's second verb: restart the server, armed first
// because every connected session dies with it.

import { useState, useTransition } from 'react'

import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import { errorText } from '../../../lib/redact'
import { restartClaudeFn } from '../../../server/claude'
import { GHOST_BTN } from '../../apps/shared'
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

/**
 * Restart the Remote Control server, through the controller's
 * `claude.restart`.
 *
 * The server is the controller's `daedalus-claude-rc` user unit, which a
 * rebuild does not restart (it restarts the controller, and the unit outlives
 * it) — so landing a new build on the running server, or recovering a wedged
 * one, is this button or a reboot. A remote session running the restart
 * itself would end with it.
 *
 * Two steps like the box restart on System › Host, but the cost spelled out at
 * arm time is a different one: sessions, not the house. The controller answers
 * at once — the instruction is queued for its session, which acts on it with
 * its next report — so the outcome shown is "queued", and the boards show the
 * new server on the next load.
 */
export function RestartServerControl({ live, reporting }: { live: number; reporting: boolean }) {
  const [armed, arm, disarm] = useArmed(RC_ARM_MS)
  const [busy, start] = useTransition()
  const [said, setSaid] = useState<{ text: string; failed: boolean } | null>(null)

  if (busy) {
    return (
      <div className={RESTART}>
        <p className={RESTART_STATE}>Asking the controller…</p>
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
              setSaid(null)
              start(async () => {
                try {
                  await restartClaudeFn()
                  setSaid({
                    text: 'Queued: the controller restarts the server with its next report. The boards above show the new one on the next load.',
                    failed: false,
                  })
                } catch (e) {
                  setSaid({ text: errorText(e), failed: true })
                }
              })
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
      {said !== null && (
        <p className={cn(RESTART_STATE, said.failed ? 'text-danger' : 'text-success')}>
          {said.text}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        onClick={arm}
        disabled={!reporting}
      >
        Restart the server
      </Button>
    </div>
  )
}
