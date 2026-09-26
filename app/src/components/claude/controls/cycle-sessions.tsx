// The roster's one board-wide verb: stop-and-resume every managed session
// still on an older CLI than the flake holds. Rendered by roster/board.tsx,
// which hands it the board's `running` flag.
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { RosterEntry } from '../../../lib/claude-roster'
import { cn } from '../../../lib/cn'
import { num, text } from '../../../lib/format'
import { resumeSessionFn, stopSessionFn } from '../../../server/claude'
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
 * Put every session this box owns back on the binary the flake holds.
 *
 * A session runs the CLI it STARTED on, and a rebuild deliberately does not
 * restart anything (platform/claude-rc.nix), so after an update the roster is
 * a mix of versions. This is the gesture that resolves it, and it is the only
 * one that can: a stopped session cannot be picked back up from claude.ai —
 * the server bridges new sessions rather than re-adopting old ones — so the
 * way back in is the transcript, through `claude --resume`, which is exactly
 * what a `claude-session@<uuid>` unit runs.
 *
 * So it acts on the MANAGED rows only, and each one is a stop followed by a
 * resume of the same uuid: same id, same transcript, appended to. Sessions
 * living inside the Remote Control server's own cgroup are not here — they
 * cannot be stopped individually, only with the server, which is the button
 * on the board above; afterwards they appear on this roster as resumable and
 * Resume per row brings each back.
 *
 * Sequential, and that is forced rather than chosen: one request file backs
 * every verb on this board, so two in flight is not a state the host can be
 * in. It is also why this shares the board's `running` — a cycle and a row
 * button must never be pressed at once.
 */
export function CycleSessionsControl({
  rows,
  holds,
  boardBusy,
}: {
  rows: RosterEntry[]
  holds: string | null
  boardBusy: boolean
}) {
  const router = useRouter()
  const [armed, arm, disarm] = useArmed(RC_ARM_MS)
  const [at, setAt] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Managed, alive, and running something other than what the flake holds.
  // A row already on the new binary is not cycled: restarting it would cost
  // a live session to change nothing.
  const stale = rows.filter(
    (r) =>
      r.managed &&
      r.id !== null &&
      r.live !== null &&
      holds !== null &&
      (r.live.version ?? null) !== null &&
      r.live.version !== holds,
  )

  if (stale.length === 0) return null

  const run = async () => {
    setError(null)
    for (const [i, row] of stale.entries()) {
      if (row.id === null) continue
      setAt(i)
      try {
        // Stop, then resume the same uuid. The host settles the unit before
        // it reports, so awaiting each verb in turn is enough — there is no
        // second status to race.
        await stopSessionFn({ data: { session: row.id } })
        await resumeSessionFn({ data: { session: row.id } })
      } catch (e) {
        setError(
          `${row.label}: ${e instanceof Error ? e.message : String(e)}. The rest were left alone.`,
        )
        break
      }
    }
    setAt(null)
    await router.invalidate()
  }

  if (at !== null) {
    return (
      <div className={RESTART}>
        <p className={RESTART_STATE}>
          Cycling {num(at + 1)} of {num(stale.length)} — {stale[at]?.label ?? ''}…
        </p>
      </div>
    )
  }

  if (armed) {
    return (
      <div className={cn(RESTART, RESTART_ARMED)}>
        <p className={RESTART_COST}>
          {stale.length === 1 ? 'This session' : `These ${num(stale.length)} sessions`} stop and
          resume, one at a time:{' '}
          <span className={MONO}>{stale.map((r) => r.label).join(', ')}</span>. Each keeps its id
          and its transcript and is appended to, not branched. Anything mid-turn loses that turn.{' '}
          <b>If you are reading this from one of them, it is the one that dies</b> — it comes back,
          but not this page's connection to it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              disarm()
              void run()
            }}
          >
            Cycle {num(stale.length)} onto {text(holds)}
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
      {error !== null && <p className={cn(RESTART_STATE, 'text-danger')}>{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={GHOST_BTN}
          disabled={boardBusy}
          onClick={arm}
        >
          Restart {num(stale.length)} session{stale.length === 1 ? '' : 's'} onto {text(holds)}
        </Button>
        <span className={RESTART_NOTE}>
          {stale.length === 1 ? 'one session is' : `${num(stale.length)} sessions are`} still
          running an older CLI than the flake holds; stop-and-resume is what moves them.
        </span>
      </div>
    </div>
  )
}
