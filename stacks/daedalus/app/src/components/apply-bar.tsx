import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ApplyStatus } from '../lib/apply'
import { applyRegistry, fetchApplyStatus } from '../server/registry'
import { usePolledStatus } from './status'

// The commit bar. Appears when the database no longer describes what Nix
// built, and stays until an apply reconciles them.
//
// Applying is a real system rebuild, so this is the one control in the app
// that is deliberately slow, explicit, and impossible to trigger by accident:
// it names what changed, it needs a click, and it reports the phase the host
// agent is actually in rather than a spinner.

const PHASES = [
  'waiting',
  'validating',
  'writing',
  'committing',
  'building',
  'switching',
  'pushing',
] as const

export function ApplyBar({
  changed,
  initialStatus,
}: {
  changed: { name: string; fields: string[] }[]
  initialStatus: ApplyStatus
}) {
  const router = useRouter()
  // Why the host refused to start (already running, nothing to apply) —
  // distinct from status.error, which is a run that started and failed.
  const [refusal, setRefusal] = useState<string | null>(null)

  const { status, running, start } = usePolledStatus({
    initial: initialStatus,
    fetch: () => fetchApplyStatus(),
    onSettle: () => {
      // Pull fresh drift + status: a successful apply clears the bar.
      void router.invalidate()
    },
  })

  if (changed.length === 0 && !running && status.state !== 'failed') return null

  // The phase vocabulary lives in host/apply.sh; a phase this list has not
  // heard of must still render as progress, not blank the tracker.
  const activeIndex = PHASES.indexOf(status.phase as (typeof PHASES)[number])

  return (
    <div
      className={`apply-bar ${running ? 'is-running' : ''} ${status.state === 'failed' ? 'is-failed' : ''}`}
    >
      <div className="apply-summary">
        {running ? (
          <>
            <strong>Applying…</strong>
            <ol className="phases">
              {PHASES.map((p, i) => (
                <li key={p} className={p === status.phase ? 'now' : i < activeIndex ? 'past' : ''}>
                  {p}
                </li>
              ))}
              {activeIndex === -1 && status.phase !== '' && <li className="now">{status.phase}</li>}
            </ol>
          </>
        ) : status.state === 'failed' ? (
          <>
            <strong>Apply failed at {status.phase}.</strong> The system was rolled back to the
            previous commit.
            <pre className="apply-error">{status.error}</pre>
          </>
        ) : (
          <>
            <strong>
              {changed.length} app{changed.length === 1 ? '' : 's'} changed
            </strong>
            <span className="apply-detail">
              {changed.map((c) => `${c.name} (${c.fields.join(', ')})`).join(' · ')}
            </span>
            {refusal !== null && <span className="bad-text">{refusal}</span>}
          </>
        )}
      </div>

      <button
        type="button"
        className="btn btn-primary"
        disabled={running || changed.length === 0}
        onClick={() => {
          setRefusal(null)
          start(async () => {
            const r = await applyRegistry()
            if (!r.ok) {
              setRefusal(r.reason)
              return null
            }
            return r.id
          })
        }}
      >
        {running ? 'Applying…' : 'Apply'}
      </button>
    </div>
  )
}
