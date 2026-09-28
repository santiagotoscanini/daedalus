import { useState } from 'react'

import type { ControllerRotation } from '../../../host/controller/wire'
import { ROTATION_GRACE, ROTATION_GRACES, type RotationGrace } from '../../../lib/agent/policy'
import { cn } from '../../../lib/cn'
import { until } from '../../../lib/format'
import { rotateControllerKeyFn } from '../../../server/nodes'
import { Button } from '../../ui/button'
import { Picker } from '../../ui/picker'
import { useAction } from '../../use-action'
import { useArmed } from '../../use-armed'
import { ASIDE, ERROR_NOTE, Line, Mono, NOTE } from '../shared'

// The controller's key, handed on: `controller.rotate` through
// server/nodes.ts. Armed first, because a machine too old to follow the
// rotation is locked out once the old key retires, and the page says so
// before the click rather than after.

/** Long enough to pick a grace and read the cost; disarms on its own after. */
const ARM_MS = 60_000

const GRACE_OPTIONS = ROTATION_GRACES.map((g) => ({ value: g, label: ROTATION_GRACE[g].label }))

/** The rotation under way, as one row value: from which key, when it retires, who still uses it. */
export function RotationState({ r }: { r: ControllerRotation }) {
  const left = (Date.parse(r.retiresAt) - Date.now()) / 1000
  const old = r.oldKeyConnections
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Line>
        <span>
          from <Mono>{r.fromFingerprint}</Mono>
        </span>
        <span className={ASIDE}>
          the old key retires {left > 0 ? `in ${until(left)}` : 'at the next start'} (
          {r.retiresAt.slice(0, 16).replace('T', ' ')} UTC)
        </span>
      </Line>
      <span className={cn(ASIDE, old > 0 && 'text-warning')}>
        {old === 0
          ? 'no machine is connected under the old key'
          : `${String(old)} machine${old === 1 ? '' : 's'} still connected under the old key — each was sent the statement, so one that stays runs an agent older than 0.19.0`}
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
      <p className={NOTE}>
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
    <div className="flex flex-col gap-3 rounded-md border border-(--border-soft) p-3">
      <p className={NOTE}>
        The controller makes a new key now and serves both for the grace period. Every machine on
        agent 0.19.0 or newer that connects in that time is handed the old key's signed statement,
        re-pins itself and reconnects under the new key — nothing to do on it. A machine older than
        0.19.0 ignores the statement, and so is one that stays off the whole time: once the old key
        retires it is refused until you re-run its install line there. The install lines below pin
        the new key from the moment you confirm.
      </p>
      <Line>
        <span className={ASIDE}>Both keys served for</span>
        <Picker
          value={grace}
          onChange={(v) => setGrace(v as RotationGrace)}
          options={GRACE_OPTIONS}
          className="w-32"
        />
      </Line>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => {
            disarm()
            run(() => rotateControllerKeyFn({ data: { grace } }))
          }}
        >
          Rotate now
        </Button>
        <Button size="sm" variant="ghost" onClick={disarm}>
          Cancel
        </Button>
        <span className={ASIDE}>disarms on its own in {ARM_MS / 1000}s</span>
      </div>
    </div>
  )
}
