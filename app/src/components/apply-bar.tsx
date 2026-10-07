import { useRouter } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { ApplyStatus } from '../host/apply'
import { cn } from '../lib/cn'
import { REBOOT_REQUIRED } from '../lib/reboot-required'
import { applyRegistry, discardPending, fetchApplyStatus } from '../server/registry'
import { ARM_MS } from './armed-confirm'
import { RebootRequired } from './reboot-required'
import { usePolledStatus } from './status'
import { Button } from './ui/button'
import { useAction } from './use-action'
import { useArmed } from './use-armed'

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
  // Discard is two presses: the first arms it and says what it throws away,
  // the second does it, and it disarms itself if nobody confirms.
  const [armed, arm, disarm] = useArmed(ARM_MS)
  const discard = useAction()
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

  // An Apply whose build needs a reboot (lib/reboot-required.ts) committed and
  // built the change but activated nothing; the bar keeps saying so until the
  // box has booted since (host/apply.ts readApplyStatus).
  const rebootPending =
    !running &&
    status.state === 'done' &&
    status.phase === REBOOT_REQUIRED &&
    status.rebootPending === true

  // The room the floating bar covers, measured: the bar wraps to two or three
  // lines on a phone, so a fixed spacer either hid the page's end under it or
  // left a gap on a desktop.
  const bar = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState(96)
  useEffect(() => {
    const el = bar.current
    if (el === null) return
    const ro = new ResizeObserver(() => setRoom(el.offsetHeight + 24))
    ro.observe(el)
    return () => ro.disconnect()
  })

  if (changed.length === 0 && !running && status.state !== 'failed' && !rebootPending) return null

  // The phase vocabulary lives in nix/stacks/daedalus/host/apply.sh; a phase this list has not
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
    <>
      {/* The room the floating bar covers, reserved only while it is shown,
          so the end of the page is never hidden under it. */}
      <div aria-hidden="true" style={{ height: room }} />
      <div
        ref={bar}
        className={cn(
          // `left` is the sidebar's width, not a copy of it: the bar is fixed,
          // so it cannot inherit the grid column, and the collapsed rail moves
          // that variable rather than this rule.
          // A dock floating over the page's foot, inset like the rail.
          'fixed right-[clamp(0.75rem,2.5vw,2.5rem)] bottom-4 left-[calc(var(--sidebar-w)+clamp(0.75rem,2.5vw,2.5rem))] z-20',
          'max-rail:right-3 max-rail:left-3',
          // One line on a desktop; on a phone the words take the full width
          // and the buttons a row of their own, right-aligned.
          'flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5',
          'rounded-2xl px-5 py-3 max-[40rem]:px-4',
          // Glass rather than opaque: the bar sits over the end of a scrolling
          // page, and content disappearing under a hard edge reads as the page
          // having ended. The edge carries the state; a glow under it, the urgency.
          'border bg-popover/75 backdrop-blur-2xl backdrop-saturate-150',
          'shadow-[inset_0_1px_0_var(--hairline-hi),var(--float-shadow)]',
          status.state === 'failed'
            ? 'border-danger/50 shadow-[inset_0_1px_0_var(--hairline-hi),var(--float-shadow),0_0_40px_-12px_var(--danger)]'
            : 'border-primary/35 shadow-[inset_0_1px_0_var(--hairline-hi),var(--float-shadow),0_0_40px_-14px_var(--primary)]',
        )}
      >
        <div className="min-w-0 flex-[1_1_20rem] text-[0.87rem] max-[40rem]:basis-full">
          {running ? (
            <>
              <strong>Applying…</strong>
              <ol className="ml-3.5 inline-flex max-w-full list-none flex-wrap gap-x-3.5 gap-y-1 p-0 text-muted-foreground text-xs max-[40rem]:mt-1 max-[40rem]:ml-0 max-[40rem]:flex">
                {phases.map((p, i) => (
                  <li
                    key={p}
                    className={cn(
                      p === status.phase && 'text-primary',
                      i < activeIndex && 'text-subdued line-through',
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
          ) : rebootPending ? (
            <>
              <strong>The last Apply takes effect at the next boot.</strong>
              <div className="mt-1.5">
                <RebootRequired note={status.error} />
              </div>
            </>
          ) : (
            <>
              <strong className="mr-2.5">{heading(changed)}</strong>
              {/* One line on a phone, the whole list on hover. */}
              <span
                className="text-muted-foreground max-[40rem]:block max-[40rem]:truncate"
                title={changed.map((c) => `${c.name} (${c.fields.join(', ')})`).join(' · ')}
              >
                {changed.map((c) => `${c.name} (${c.fields.join(', ')})`).join(' · ')}
              </span>
              {refusal !== null && <span className="ml-2.5 text-danger">{refusal}</span>}
              {discard.error !== null && (
                <span className="ml-2.5 text-danger">{discard.error}</span>
              )}
              {discard.notice !== null && (
                <span className="ml-2.5 text-muted-foreground">{discard.notice}</span>
              )}
            </>
          )}
        </div>

        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          {!running && changed.length > 0 && armed && (
            <>
              <span className="text-muted-foreground text-xs">
                Back to the last Apply: every edit above is lost.
              </span>
              <Button
                type="button"
                variant="destructive"
                disabled={discard.busy}
                onClick={() => {
                  disarm()
                  discard.run(() => discardPending(), {
                    notice: ({ value: v }) =>
                      v.kept.length === 0
                        ? 'Discarded.'
                        : `Discarded; kept ${v.kept.join(', ')}, which an Apply carries or a page undoes.`,
                  })
                }}
              >
                Discard
              </Button>
              <Button type="button" variant="ghost" onClick={disarm}>
                Cancel
              </Button>
            </>
          )}
          {!running && changed.length > 0 && !armed && (
            <Button type="button" variant="outline" disabled={discard.busy} onClick={arm}>
              {discard.busy ? 'Discarding…' : 'Discard'}
            </Button>
          )}
          <Button
            type="button"
            disabled={running || changed.length === 0 || armed || discard.busy}
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
      </div>
    </>
  )
}
