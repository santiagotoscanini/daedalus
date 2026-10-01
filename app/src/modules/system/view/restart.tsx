import { useRef, useState } from 'react'
import { GHOST_BTN } from '../../../components/apps/shared'
import {
  ARM_MS,
  ArmedConfirm,
  RESTART,
  RESTART_NOTE,
  RESTART_STATE,
} from '../../../components/armed-confirm'
import { usePoll } from '../../../components/poll'
import { MONO } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { useArmed } from '../../../components/use-armed'
import { cn } from '../../../lib/cn'
import { duration, num } from '../../../lib/format'
import { errorText } from '../../../lib/redact'
import { requestRebootFn } from '../../../server/host'

/* The restart control, under the case photo. Quiet at rest and deliberately
   not primary: it is one ghost button with no colour of its own, because a
   control that looks important gets clicked to find out what it does. */
const HEALTH_MS = 3_000

type RestartPhase = 'idle' | 'dispatching' | 'refused' | 'down' | 'back'

/**
 * Restart the box.
 *
 * Two steps rather than one click, and the second step is where the cost is
 * spelled out: this is the only control in the app that takes the whole house
 * offline, because pi-hole is this machine and every device in it resolves
 * through here.
 *
 * The interesting half is what happens AFTER dispatch. The host's answer is a
 * refusal (it will not reboot mid-rebuild) or the reboot queued, and then
 * nothing can report it finished — the answering process goes down with the
 * box — so the box itself becomes the signal: /api/healthz answering again is
 * the completion event. Failed fetches in that phase are the expected path,
 * not an error.
 */
export function RestartControl({
  containers,
  uptimeSeconds,
}: {
  containers: number | null
  uptimeSeconds: number | null
}) {
  const [phase, setPhase] = useState<RestartPhase>('idle')
  const [armed, arm, disarm] = useArmed(ARM_MS)
  const [refusal, setRefusal] = useState('')
  // "Back" only means something after a "gone": the first health poll is
  // answered by a container that has not been told to stop yet, and without
  // this the restart would report itself finished before it had begun.
  // The ref is what the poll decides on — the effect closes over it once — and
  // the state beside it is what the copy reads.
  const gone = useRef(false)
  const [sawDown, setSawDown] = useState(false)

  // Nothing will report the restart finished, so this phase asks the box
  // instead. /api/healthz is the one unauthenticated path (it is the
  // forward-auth bypass gatus uses), which is what makes it answerable the
  // moment the app is serving again.
  usePoll(
    async () => {
      const r = await fetch('/api/healthz', { cache: 'no-store' }).catch(() => null)
      if (r?.ok !== true) {
        gone.current = true
        setSawDown(true)
        return
      }
      if (gone.current) setPhase('back')
    },
    HEALTH_MS,
    phase === 'down',
  )

  if (armed && phase !== 'dispatching' && phase !== 'down') {
    return (
      <ArmedConfirm
        cost={
          <>
            Everything on this box stops for a couple of minutes.{' '}
            <strong className="font-medium text-warning">LAN DNS goes down with it</strong>: pi-hole
            is this machine, so no device in the house resolves a name until it is back.{' '}
            {containers === null ? 'Every container' : `All ${num(containers)} containers`} stop and
            start again, and {duration(uptimeSeconds)} of uptime goes back to zero.
          </>
        }
        confirm="Confirm restart"
        onConfirm={() => {
          disarm()
          setRefusal('')
          gone.current = false
          setSawDown(false)
          setPhase('dispatching')
          void requestRebootFn()
            .then((r) => {
              if (r.state === 'rebooting') {
                setPhase('down')
              } else {
                setRefusal(r.reason)
                setPhase('refused')
              }
            })
            .catch((e: unknown) => {
              // A fetch that fails outright is the server going down under
              // the answer; an error the server wrote is a refusal.
              if (e instanceof TypeError) {
                setPhase('down')
                return
              }
              setRefusal(errorText(e))
              setPhase('refused')
            })
        }}
        onCancel={disarm}
      />
    )
  }

  if (phase === 'dispatching' || phase === 'down') {
    return (
      <div className={RESTART}>
        <p className={RESTART_STATE}>
          {phase === 'dispatching'
            ? 'Asking the host to restart…'
            : sawDown
              ? 'The box is down. Waiting for it to answer again…'
              : 'Restarting. This page will stop responding shortly.'}
        </p>
        <p className={RESTART_NOTE}>
          Nothing will report this finished: the server goes down with the box. This is watching{' '}
          <span className={MONO}>/api/healthz</span> instead.
        </p>
      </div>
    )
  }

  return (
    <div className={RESTART}>
      {phase === 'back' && (
        <p className={cn(RESTART_STATE, 'text-success')}>
          The box is back, and this page is talking to it.
        </p>
      )}
      {phase === 'refused' && <p className={cn(RESTART_STATE, 'text-danger')}>{refusal}</p>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        onClick={() => {
          setPhase('idle')
          arm()
        }}
      >
        Restart the box
      </Button>
    </div>
  )
}
