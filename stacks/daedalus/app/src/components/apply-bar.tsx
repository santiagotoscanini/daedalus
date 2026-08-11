import { useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { ApplyStatus } from '../lib/apply'
import { applyRegistry, fetchApplyStatus } from '../server/registry'

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
  const [status, setStatus] = useState<ApplyStatus>(initialStatus)
  const [submitting, setSubmitting] = useState(false)

  const running = status.state === 'running' || submitting

  // Poll only while something is in flight. A rebuild takes minutes, so the
  // page cannot just wait on the request — the host agent owns the work and
  // reports through a status file.
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => {
      void fetchApplyStatus().then((s) => {
        setStatus(s)
        if (s.state !== 'running') {
          setSubmitting(false)
          // Pull fresh drift + status: a successful apply clears the bar.
          void router.invalidate()
        }
      })
    }, 2000)
    return () => {
      clearInterval(t)
    }
  }, [running, router])

  if (changed.length === 0 && !running && status.state !== 'failed') return null

  return (
    <div
      className={`apply-bar ${running ? 'is-running' : ''} ${status.state === 'failed' ? 'is-failed' : ''}`}
    >
      <div className="apply-summary">
        {running ? (
          <>
            <strong>Applying…</strong>
            <ol className="phases">
              {PHASES.map((p) => (
                <li
                  key={p}
                  className={
                    p === status.phase
                      ? 'now'
                      : PHASES.indexOf(p) < PHASES.indexOf(status.phase as (typeof PHASES)[number])
                        ? 'past'
                        : ''
                  }
                >
                  {p}
                </li>
              ))}
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
          </>
        )}
      </div>

      <button
        type="button"
        className="btn btn-primary"
        disabled={running || changed.length === 0}
        onClick={() => {
          setSubmitting(true)
          void applyRegistry().then((r) => {
            if (!r.ok) setSubmitting(false)
          })
        }}
      >
        {running ? 'Applying…' : 'Apply'}
      </button>
    </div>
  )
}
