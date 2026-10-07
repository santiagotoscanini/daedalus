import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'

import type { SessionHostLine } from '../../../host/session-host'
import { fetchSessionHostFn, restartSessionHostFn } from '../../../server/nodes'
import { ArmedConfirm } from '../../armed-confirm'
import { useRootAction } from '../../root-action'
import { Button } from '../../ui/button'
import { useArmed } from '../../use-armed'
import { Chip } from '../../viz'
import { ASIDE, ERROR_NOTE, INSET, Line, Mono, NOTE_SHOWN } from '../shared'

// The session host on one line (host/session-host.ts): how it stands, which
// build runs, the terminals it holds and the machines connected, and the
// restart. A restart ends every live terminal, so it is armed first and the
// confirm counts them afresh rather than trusting the count the page loaded.

/** Long enough to read the count; disarms on its own after. */
const ARM_MS = 30_000

export function SessionHost({ line }: { line: SessionHostLine }) {
  const router = useRouter()
  const [armed, arm, disarm] = useArmed(ARM_MS)
  // The confirm's own reading, taken as it arms; the loaded line until it lands.
  const [fresh, setFresh] = useState<SessionHostLine | null>(null)
  const { running, answer, start } = useRootAction({
    onSettle: () => {
      void router.invalidate()
    },
  })

  return (
    <span className="inline-flex flex-col items-start gap-2">
      <Line>
        <Chip tone={line.tone}>{line.chip}</Chip>
        {line.restartPending && <Chip tone="warn">update installed, restart to apply</Chip>}
        {line.version !== null && <Mono>{line.version}</Mono>}
        {line.facts.length > 0 && <span className={ASIDE}>{line.facts.join(' · ')}</span>}
      </Line>
      {line.error !== null && <span className={ERROR_NOTE}>{line.error}</span>}
      {armed ? (
        <ArmedConfirm
          ms={ARM_MS}
          className={INSET}
          costClassName={NOTE_SHOWN}
          noteClassName={ASIDE}
          cost={(fresh ?? line).confirm}
          confirm="Restart now"
          onConfirm={() => {
            disarm()
            start(() => restartSessionHostFn())
          }}
          onCancel={disarm}
        />
      ) : (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={running}
            onClick={() => {
              setFresh(null)
              arm()
              void fetchSessionHostFn().then(setFresh, () => undefined)
            }}
          >
            {running ? 'Restarting…' : 'Restart'}
          </Button>
          {answer !== null && answer.outcome !== 'done' && (
            <span className={ERROR_NOTE}>
              {answer.detail === '' ? `the restart ${answer.outcome}` : answer.detail}
            </span>
          )}
        </span>
      )}
    </span>
  )
}
