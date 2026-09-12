// Step 3 of "add an app": one verdict, and whatever is left to do about it.
//
// The panel is deliberately dumb — lib/readiness.ts has already decided what
// needs acting on and what needs nothing, and every string on a row is the
// check's own copy, verbatim. What is left here is the shape: the answer
// first, and anything settled folded away, so the step gets SHORTER as the
// repo gets closer to creatable.

import { cn } from '../../lib/cn'
import type { Check, CheckState, Readiness } from '../../lib/readiness'
import { type Tone, toneStyle } from '../../lib/tone'
import { RefreshButton } from '../controls'
import { SECTION_HEAD, SECTION_HEAD_SMALL } from './shared'

const MARK: Record<CheckState, string> = { ok: '✓', warn: '!', bad: '✗', unknown: '?' }

/** `unknown` is grey rather than red on purpose: an image on a registry this
    box cannot see is unverified, not broken, and painting that as a failure is
    how a checklist becomes something you click past. */
const STATE_TONE: Record<CheckState, Tone> = {
  ok: 'ok',
  warn: 'warn',
  bad: 'bad',
  unknown: 'muted',
}

/** The fold that replaces the verdict once there is nothing left to do. */
const FOLD_SUMMARY = cn(
  "flex cursor-pointer list-none items-center gap-[0.45rem] px-4 py-[0.6rem] text-[0.8rem] text-(--text-muted) before:text-[0.7rem] before:text-(--dim) before:transition-transform before:duration-[120ms] before:content-['▸']",
  '[&::-webkit-details-marker]:hidden',
  'group-open:border-b group-open:border-b-(--border-soft) group-open:before:rotate-90',
  'hover:bg-(--panel-2) hover:text-foreground',
  // Inset: the summary is full-bleed inside a clipping panel, so an outward
  // offset would be cut off by the panel's own rounded edge.
  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--brand-dim)',
)

/** One list of checks, hairline-separated. */
const CHECKLIST = 'm-0 list-none p-0 [&>li+li]:border-t [&>li+li]:border-t-(--border-soft)'

export function ReadinessPanel({
  plan,
  refreshing,
  onRefresh,
}: {
  plan: Readiness
  refreshing: boolean
  onRefresh: () => void
}) {
  return (
    <>
      <h2 className={SECTION_HEAD}>
        3. Readiness
        <small className={SECTION_HEAD_SMALL}>is there an image this box can pull?</small>
        <RefreshButton busy={refreshing} label="Re-run the checks" onClick={onRefresh} />
      </h2>

      {/* Step 3 asks one question and gets one answer, so it is drawn as one
          panel: the verdict, then whatever is still to be done about it. */}
      <div className="mb-[1.2rem] overflow-hidden rounded-lg border border-(--border-soft) bg-(--panel) [&>*+*]:border-t [&>*+*]:border-t-(--border-soft)">
        {plan.ready ? (
          // The whole step, once there is nothing left to do about it. It is
          // the answer now, not a fold under one, so it is drawn at the
          // panel's own weight.
          <details className="group">
            <summary className={cn(FOLD_SUMMARY, 'py-[0.85rem] text-[0.92rem] text-foreground')}>
              <span className="text-success" aria-hidden="true">
                ✓
              </span>{' '}
              Ready: the image is published
            </summary>
            <ul className={CHECKLIST}>
              {plan.settled.map((c) => (
                <Row key={c.id} check={c} />
              ))}
            </ul>
          </details>
        ) : (
          <>
            {/* The answer, with its own cause already absorbed into it. */}
            <div
              className="grid grid-cols-[1.6rem_minmax(0,1fr)] items-baseline gap-[0.6rem] border-l-[3px] border-l-(--tone) px-4 py-[0.9rem]"
              style={toneStyle(STATE_TONE[plan.verdict.state])}
            >
              <span className="font-bold text-(--tone)" aria-hidden="true">
                {MARK[plan.verdict.state]}
              </span>
              <span className="grid min-w-0 gap-[0.2rem]">
                <span>{plan.verdict.headline}</span>
                {/* The image reference the verdict is about, in the face it is
                    written in. */}
                <span className="font-mono text-[0.86em] text-(--text-muted) [overflow-wrap:anywhere]">
                  {plan.verdict.subject}
                </span>
              </span>
            </div>

            {plan.act.length > 0 && (
              <ol className={CHECKLIST}>
                {plan.act.map((c, i) => (
                  <Row key={c.id} check={c} step={i + 1} />
                ))}
              </ol>
            )}

            {plan.settled.length > 0 && (
              <details className="group">
                <summary className={FOLD_SUMMARY}>{plan.settled.length} already fine</summary>
                <ul className={CHECKLIST}>
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

/** Enough for the whole list; past it the plain number still reads. */
const NUMERALS = '①②③④⑤⑥⑦⑧⑨'

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
}: {
  check: Check
  /** Position in the act list, drawn instead of the state mark. */
  step?: number
}) {
  return (
    <li
      className="grid grid-cols-[1.6rem_minmax(0,1fr)_auto] items-baseline gap-x-[0.6rem] gap-y-[0.2rem] px-4 py-[0.7rem]"
      style={toneStyle(STATE_TONE[check.state])}
    >
      <span
        className={cn(
          'font-bold',
          // Numbered rather than marked: everything in the act list has
          // already failed, so the useful thing to print is the order the
          // fixes have to happen in.
          step === undefined ? 'text-(--tone)' : 'font-normal text-danger',
        )}
        aria-hidden="true"
      >
        {step === undefined ? MARK[check.state] : (NUMERALS[step - 1] ?? String(step))}
      </span>
      <span className="grid min-w-0 gap-[0.15rem]">
        <b>{check.label}</b>
        <span className="text-[0.85rem] text-(--text-muted)">{check.detail}</span>
        {check.fix !== undefined && (
          <span className="text-[0.82rem] text-(--dim)">{check.fix}</span>
        )}
      </span>
    </li>
  )
}
