// Step 3 of "add an app": one verdict, then whatever is left to do about it.
//
// The panel is deliberately dumb — lib/readiness.ts has already decided what
// is a cause, what is a consequence and what needs nothing, and every string
// on a row is the check's own copy, verbatim. What is left here is the shape:
// the answer first, the actions numbered in the order they have to happen, and
// everything else folded away, so the step gets SHORTER as the repo gets
// closer to creatable rather than staying a wall of seven equal rows.

import type { ReactNode } from 'react'
import type { Check, CheckState } from '../../lib/github-repos'
import type { BlockedCheck, Readiness } from '../../lib/readiness'
import { RefreshButton } from '../ui'

/** What the host said back about an action fired from one of these rows. */
export type HostNote = {
  id: string
  state: 'running' | 'done' | 'failed'
  message: string
}

const MARK: Record<CheckState, string> = { ok: '✓', warn: '!', bad: '✗', unknown: '?' }

/** Enough for the whole graph; past it the plain number still reads. */
const NUMERALS = '①②③④⑤⑥⑦⑧⑨'

export function ReadinessPanel({
  plan,
  refreshing,
  onRefresh,
  action,
  notes,
}: {
  plan: Readiness
  refreshing: boolean
  onRefresh: () => void
  /** The button that fixes a row, when this box can fix it. */
  action: (c: Check) => ReactNode
  notes: readonly HostNote[]
}) {
  // "REGISTRY_PASSWORD set on santiagotoscanini/voyra" belongs on the line
  // that asked for it — but the answer is what moves that line out of the act
  // list, and a note folded away with it would read as the button having done
  // nothing. Once its row is gone, the note stands on its own.
  const orphans = notes.filter((n) => !plan.act.some((c) => c.id === n.id))

  return (
    <>
      <h2 className="section-head">
        3. Readiness
        <small>can this repo publish an image?</small>
        <RefreshButton busy={refreshing} label="Re-run the checks" onClick={onRefresh} />
      </h2>

      <div className="readiness">
        {plan.ready ? (
          <>
            {orphans.map((n) => (
              <p key={n.id} className="readiness-said">
                <Said note={n} />
              </p>
            ))}
            <details className="fold fold-ready">
              <summary>
                <span className="ok-text" aria-hidden="true">
                  ✓
                </span>{' '}
                Ready: image published, workflows fine
              </summary>
              <ul className="checklist">
                {plan.settled.map((c) => (
                  <Row key={c.id} check={c} />
                ))}
              </ul>
            </details>
          </>
        ) : (
          <>
            <div className={`verdict verdict-${plan.verdict.state}`}>
              <span className="verdict-mark" aria-hidden="true">
                {MARK[plan.verdict.state]}
              </span>
              <span className="verdict-body">
                <span>{plan.verdict.headline}</span>
                <span className="verdict-subject mono">{plan.verdict.subject}</span>
                {orphans.map((n) => (
                  <Said key={n.id} note={n} />
                ))}
              </span>
            </div>

            {plan.act.length > 0 && (
              <ol className="checklist acts">
                {plan.act.map((c, i) => (
                  <Row
                    key={c.id}
                    check={c}
                    step={i + 1}
                    action={action(c)}
                    note={notes.find((n) => n.id === c.id) ?? null}
                  />
                ))}
              </ol>
            )}

            {plan.blocked.length > 0 && (
              <details className="fold">
                <summary>
                  {plan.blocked.length} {plan.blocked.length === 1 ? 'check' : 'checks'} waiting on{' '}
                  {plan.waitingOn}
                </summary>
                <ul className="checklist">
                  {plan.blocked.map((c) => (
                    <Row key={c.id} check={c} blocked={c.waitingOn} />
                  ))}
                </ul>
              </details>
            )}

            {plan.settled.length > 0 && (
              <details className="fold">
                <summary>{plan.settled.length} already fine</summary>
                <ul className="checklist">
                  {plan.settled.map((c) => (
                    <Row key={c.id} check={c} />
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
      </div>
    </>
  )
}

/**
 * One row, in whichever list it landed.
 *
 * The label, detail and fix are the check's own words everywhere: a row that
 * is folded away is folded, not summarised, so nothing this page knows is lost
 * by opening less of it.
 */
function Row({
  check,
  step,
  blocked,
  action,
  note,
}: {
  check: Check | BlockedCheck
  /** Position in the act list, drawn instead of the state mark. */
  step?: number
  /** What this row waits on, when it is in the blocked fold. */
  blocked?: string
  action?: ReactNode
  note?: HostNote | null
}) {
  return (
    <li className={blocked === undefined ? `check check-${check.state}` : 'check check-blocked'}>
      <span className="check-mark" aria-hidden="true">
        {step === undefined ? MARK[check.state] : (NUMERALS[step - 1] ?? String(step))}
      </span>
      <span className="check-body">
        <b>{check.label}</b>
        <span className="check-detail">{check.detail}</span>
        {check.fix !== undefined && <span className="check-fix">{check.fix}</span>}
        {blocked !== undefined && <span className="check-fix">waiting on {blocked}</span>}
        {note !== undefined && note !== null && <Said note={note} />}
      </span>
      {action !== undefined && action !== null && <span className="check-action">{action}</span>}
    </li>
  )
}

function Said({ note }: { note: HostNote }) {
  return (
    <span className={note.state === 'failed' ? 'check-said bad-text' : 'check-said ok-text'}>
      {note.message}
    </span>
  )
}
