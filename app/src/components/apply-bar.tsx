import { useRouter } from '@tanstack/react-router'
import type { ApplyStatus } from '../host/apply'
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

const PHASES: readonly string[] = [
  'waiting',
  'validating',
  'writing',
  'committing',
  'building',
  'switching',
  'pushing',
]

/**
 * "2 apps changed", "The site changed", "1 app and the site changed", "The
 * machines changed". The entries named `site` and `nodes` are the site
 * document and the machines (host/apply-flow.ts), not apps, and counting
 * either as one would misstate what the rebuild is for.
 */
function heading(changed: { name: string }[]): string {
  const apps = changed.filter((c) => c.name !== 'site' && c.name !== 'nodes').length
  const site = changed.some((c) => c.name === 'site')
  const machines = changed.some((c) => c.name === 'nodes')
  const parts = [
    apps > 0 && `${String(apps)} app${apps === 1 ? '' : 's'}`,
    site && 'the site',
    machines && 'the machines',
  ]
    .filter((p): p is string => typeof p === 'string')
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1')
  const s = `${parts} changed`
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function ApplyBar({
  changed,
  initialStatus,
}: {
  changed: { name: string; fields: string[] }[]
  initialStatus: ApplyStatus
}) {
  const router = useRouter()
  // `refusal` is why the host would not start (already running, nothing to
  // apply) — distinct from status.error, which is a run that started and
  // failed.
  const { status, running, refusal, start } = usePolledStatus({
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
  //
  // Under an engine override (site.json `developer.engineOverride`) the agent
  // activates with `nixos-rebuild test` and reports `testing` in the slot
  // where `switching` would be. Same step, different verb — so it takes that
  // slot rather than appearing as an unknown phase after it.
  const phases =
    status.phase === 'testing' ? PHASES.map((p) => (p === 'switching' ? 'testing' : p)) : PHASES
  const activeIndex = phases.indexOf(status.phase)

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
              {phases.map((p, i) => (
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
            <strong>{heading(changed)}</strong>
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
          start(async () => {
            const r = await applyRegistry()
            return r.ok ? { ok: true, value: r.value.id } : r
          })
        }}
      >
        {running ? 'Applying…' : 'Apply'}
      </Button>
    </div>
  )
}
