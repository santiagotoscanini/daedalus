import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import type { ApplyStatus } from '../lib/apply'
import { cn } from '../lib/cn'
import { applyRegistry, fetchApplyStatus } from '../server/registry'
import { usePolledStatus } from './status'
import { Button } from './ui/button'

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
      className={cn(
        // `left` is the sidebar's width, not a copy of it: the bar is fixed,
        // so it cannot inherit the grid column, and the collapsed rail moves
        // that variable rather than this rule.
        'fixed right-0 bottom-0 left-(--sidebar-w) z-20',
        'flex items-center justify-between gap-6',
        'px-[clamp(1rem,3.5vw,2.75rem)] py-3.5',
        // Tinted rather than opaque: the bar sits over the end of a scrolling
        // page, and content disappearing under a hard edge reads as the page
        // having ended.
        'border-t bg-card/92 backdrop-blur-md',
        status.state === 'failed' ? 'border-t-danger' : 'border-t-(--brand-dim)',
      )}
    >
      <div className="min-w-0 text-[0.87rem]">
        {running ? (
          <>
            <strong>Applying…</strong>
            <ol className="ml-3.5 inline-flex list-none gap-3.5 p-0 text-(--dim) text-xs">
              {PHASES.map((p, i) => (
                <li
                  key={p}
                  className={cn(
                    p === status.phase && 'text-primary',
                    i < activeIndex && 'text-(--text-muted) line-through',
                  )}
                >
                  {p}
                </li>
              ))}
              {activeIndex === -1 && status.phase !== '' && (
                <li className="text-primary">{status.phase}</li>
              )}
            </ol>
          </>
        ) : status.state === 'failed' ? (
          <>
            <strong>Apply failed at {status.phase}.</strong> The system was rolled back to the
            previous commit.
            <pre className="mt-1.5 mb-0 max-h-28 overflow-auto whitespace-pre-wrap text-[0.74rem] text-danger">
              {status.error}
            </pre>
          </>
        ) : (
          <>
            <strong>
              {changed.length} app{changed.length === 1 ? '' : 's'} changed
            </strong>
            <span className="ml-2.5 text-(--dim)">
              {changed.map((c) => `${c.name} (${c.fields.join(', ')})`).join(' · ')}
            </span>
            {refusal !== null && <span className="ml-2.5 text-danger">{refusal}</span>}
          </>
        )}
      </div>

      <Button
        type="button"
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
      </Button>
    </div>
  )
}
