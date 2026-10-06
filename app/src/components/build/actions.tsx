import { useState } from 'react'
import { cancelBuildFn, retryReportFn } from '../../server/builds'
import { GHOST_BTN } from '../apps/shared'
import { Button } from '../ui/button'
import { useAction } from '../use-action'

// The build page's two buttons that ask the box for something: stop this
// build, and send its failed GitHub report again. Both reload the page's
// loader afterwards so what they changed shows.

/**
 * Ask the host to stop this build. One press, one confirmation — a build is
 * minutes of work and the button sits beside "Build again", which is the pair
 * that gets misclicked.
 *
 * Pressing it twice is harmless (the server re-asks for the same thing and
 * finds the row already terminal), so the busy flag is a courtesy rather than
 * a guard.
 */
export function CancelBuildButton({ app, id }: { app: string; id: string }) {
  const [armed, setArmed] = useState(false)
  const { run: act, busy, error } = useAction()

  const run = () => {
    setArmed(false)
    act(() => cancelBuildFn({ data: { app, id } }))
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2.5 text-[0.75rem]">
      {error !== null && <span className="max-w-[28rem] text-right text-danger">{error}</span>}
      {armed && <span className="text-subdued">Stop it where it is?</span>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        disabled={busy}
        title="Stops the host builder. The build ends as cancelled; nothing is published."
        onClick={() => {
          if (armed) run()
          else setArmed(true)
        }}
      >
        {busy ? 'Stopping…' : armed ? 'Yes, cancel' : 'Cancel build'}
      </Button>
    </span>
  )
}

/** Send a failed GitHub report again now; the page reloads to show what GitHub said. */
export function RetryReportButton({ app, id }: { app: string; id: string }) {
  const { run: act, busy, error } = useAction()

  const run = () => {
    act(() => retryReportFn({ data: { app, id } }))
  }

  return (
    <span className="mt-2 inline-flex flex-wrap items-center gap-2.5 text-[0.75rem]">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        disabled={busy}
        onClick={run}
      >
        {busy ? 'Sending…' : 'Retry report'}
      </Button>
      {error !== null && <span className="text-danger">{error}</span>}
    </span>
  )
}
