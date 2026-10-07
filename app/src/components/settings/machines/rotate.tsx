import { useState } from 'react'

import type { RotationInfo } from '../../../host/controller/generated'
import { ROTATION_GRACE, ROTATION_GRACES, type RotationGrace } from '../../../lib/agent/policy'
import { cn } from '../../../lib/cn'
import { rotateControllerKeyFn } from '../../../server/nodes'
import { Until } from '../../ago'
import { ArmedConfirm } from '../../armed-confirm'
import { useNow } from '../../poll'
import { Button } from '../../ui/button'
import { Picker } from '../../ui/picker'
import { useAction } from '../../use-action'
import { useArmed } from '../../use-armed'
import { ASIDE, CONTROL_H, ERROR_NOTE, INSET, Line, Mono, NOTE_SHOWN } from '../shared'

// The controller's key, handed on: `controller.rotate` through
// server/nodes.ts. Armed first, because a machine too old to follow the
// rotation is locked out once the old key retires, and the page says so
// before the click rather than after.

/** Long enough to pick a grace and read the cost; disarms on its own after. */
const ARM_MS = 60_000

const GRACE_OPTIONS = ROTATION_GRACES.map((g) => ({ value: g, label: ROTATION_GRACE[g].label }))

/** The rotation under way, as one row value: from which key, when it retires, who still uses it. */
export function RotationState({ r }: { r: RotationInfo }) {
  const now = useNow(false)
  const left = now === null ? null : (Date.parse(r.retires_at) - now) / 1000
  const old = r.old_key_connections
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Line>
        <span>
          from <Mono>{r.from_fingerprint}</Mono>
        </span>
        <span className={ASIDE}>
          the old key retires{' '}
          {left === null || left > 0 ? (
            <>
              in <Until at={r.retires_at} />
            </>
          ) : (
            'at the next start'
          )}{' '}
          ({r.retires_at.slice(0, 16).replace('T', ' ')} UTC)
        </span>
      </Line>
      <span className={cn(ASIDE, old > 0 && 'text-warning')}>
        {old === 0
          ? 'no machine is connected under the old key'
          : `${String(old)} machine${old === 1 ? '' : 's'} still connected under the old key — each was sent the statement`}
      </span>
    </span>
  )
}

/** The button, and the step that says what happens before anything does. */
export function RotateKey({ rotating }: { rotating: boolean }) {
  const [armed, arm, disarm] = useArmed(ARM_MS)
  const [grace, setGrace] = useState<RotationGrace>('7d')
  const { run, busy, error } = useAction()

  if (rotating) {
    return (
      <p className={NOTE_SHOWN}>
        A rotation is under way; another can start once the old key has retired.
      </p>
    )
  }

  if (!armed) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <Button size="sm" variant="outline" disabled={busy} onClick={arm}>
            Rotate the controller's key
          </Button>
        </div>
        {error !== null && <p className={ERROR_NOTE}>{error}</p>}
      </div>
    )
  }

  return (
    <ArmedConfirm
      ms={ARM_MS}
      className={INSET}
      costClassName={NOTE_SHOWN}
      noteClassName={ASIDE}
      cost="The controller makes a new key now and serves both for the grace period. Every machine that connects in that time is handed the old key's signed statement, re-pins itself and reconnects under the new key — nothing to do on it. A machine that stays off the whole time is refused once the old key retires, until you re-run its install line there. The install lines below pin the new key from the moment you confirm."
      confirm="Rotate now"
      disabled={busy}
      onConfirm={() => {
        disarm()
        run(() => rotateControllerKeyFn({ data: { grace } }))
      }}
      onCancel={disarm}
    >
      <Line>
        <span className={ASIDE}>Both keys served for</span>
        <Picker
          value={grace}
          onChange={(v) => setGrace(v as RotationGrace)}
          options={GRACE_OPTIONS}
          className={cn(CONTROL_H, 'w-32')}
        />
      </Line>
    </ArmedConfirm>
  )
}
