import { useState } from 'react'
import { Ago } from '../../../components/ago'
import { SECTION_SPAN, TABLE_NONE } from '../../../components/modules/parts'
import { CELL_QUIET, TABLE, TABLE_HEAD, TABLE_ROW, TableMore } from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { AXIS, FOOT, NOTE } from '../../../components/tokens'
import { Board, type Column, Columns, Measures } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num } from '../../../lib/format'
import type { RelayCaller, RelayDay } from '../data/relay'
import { unitName } from './shared'

// Communications › the relay's rhythm: a column per day, and which units sent.

/** Callers ranked before the rest fold. */
const CALLERS_SHOWN = 8

export function FrequencyBoard({
  days,
  total,
  window,
}: {
  days: RelayDay[]
  total: number
  window: number
}) {
  const busiest = days.reduce<RelayDay | null>(
    (best, d) => (best === null || d.sent + d.failed > best.sent + best.failed ? d : best),
    null,
  )
  const active = days.filter((d) => d.sent + d.failed > 0).length
  const points: Column[] = days.map((d) => ({
    label: d.day.slice(5),
    value: d.sent + d.failed,
    failed: d.failed,
    display: `${num(d.sent)} sent${d.failed > 0 ? ` · ${num(d.failed)} failed` : ''}`,
  }))
  const first = days[0]?.day.slice(5)
  const last = days[days.length - 1]?.day.slice(5)

  return (
    <Board
      title="Deliveries per day"
      span={12}
      aside={
        <span className={NOTE}>
          {num(total)} in {num(window)} days
        </span>
      }
    >
      {busiest !== null && total > 0 && (
        <Measures
          items={[
            {
              k: 'Busiest day',
              v: `${num(busiest.sent + busiest.failed)} on ${busiest.day.slice(5)}`,
            },
            { k: 'Days with mail', v: `${num(active)} of ${num(days.length)}` },
          ]}
        />
      )}
      <Columns points={points} height={112} empty={`Nothing sent in ${String(window)} days.`} />
      {total > 0 && (
        <p className={AXIS}>
          <span>{first}</span>
          <span>deliveries per day</span>
          <span>{last}</span>
        </p>
      )}
      <p className={FOOT}>
        One column per day of the box&rsquo;s own calendar, counting every attempt msmtp logged. The
        red foot of a column is the attempts that failed that day.
      </p>
    </Board>
  )
}

/**
 * Unit, then its attempts (the ranking, with its bar), then how they went
 * and when it last sent. On a phone the counts drop under the unit.
 */
const CALLER_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_4rem_4.5rem_5.5rem]',
  '@max-[40rem]/table:grid-cols-[minmax(0,1fr)_auto] @max-[40rem]/table:gap-x-3 @max-[40rem]/table:[&>.wide]:hidden',
)
const NUM = cn(CELL_QUIET, 'wide text-right')
/** No figure: a quiet dash, so a blank cell never reads as a rendering fault. */
const NONE = <span className="text-muted-foreground/50">{DASH}</span>

/** The bar is the comparison this table exists to make, so it is the one drawn thing in a row. */
const BAR =
  'block h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-foreground/[0.08] @max-[40rem]/table:hidden'
const BAR_FILL =
  'block h-full origin-left animate-[bar-grow_600ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-full bg-muted-foreground opacity-60 motion-reduce:animate-none'

export function CallersTable({ callers, window }: { callers: RelayCaller[]; window: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? callers : callers.slice(0, CALLERS_SHOWN)
  const max = Math.max(1, ...callers.map((c) => c.sent + c.failed))

  return (
    <TableSection
      title="Who sent"
      aside={callers.length === 0 ? undefined : `${num(callers.length)} units`}
      className={SECTION_SPAN[12]}
    >
      {callers.length === 0 ? (
        <p className={TABLE_NONE}>Nothing sent in {num(window)} days.</p>
      ) : (
        <ul className={TABLE} aria-label="Who sent">
          <li className={cn(CALLER_GRID, TABLE_HEAD)}>
            <span>Unit</span>
            <span className="text-right">Attempts</span>
            <span className="wide text-right">Sent</span>
            <span className="wide text-right">Not sent</span>
            <span className="wide text-right">Last</span>
          </li>
          {shown.map((c) => (
            <CallerRow key={c.unit} c={c} max={max} />
          ))}
          {callers.length > CALLERS_SHOWN && (
            <TableMore
              open={all}
              onToggle={() => {
                setAll((v) => !v)
              }}
              more={`${num(callers.length - CALLERS_SHOWN)} more`}
              less={`Show the first ${String(CALLERS_SHOWN)}`}
            />
          )}
        </ul>
      )}
      <p className={FOOT}>
        Each unit msmtp ran inside, ranked by its attempts in the window. A failure notice is named
        by the unit whose failure it reported; hover the name for the notifier itself.
      </p>
    </TableSection>
  )
}

function CallerRow({ c, max }: { c: RelayCaller; max: number }) {
  const attempts = c.sent + c.failed
  return (
    <li className={cn(CALLER_GRID, TABLE_ROW)}>
      <span className="min-w-0">
        {/* One line, cut with an ellipsis: a unit is an identifier, and the
            whole of it is on the hover. */}
        <span className="block truncate font-mono text-[0.76rem] text-foreground" title={c.unit}>
          {c.about === null ? (
            unitName(c.unit)
          ) : (
            <>
              {c.about}{' '}
              <span className="font-sans text-[0.75rem] text-muted-foreground">failed</span>
            </>
          )}
        </span>
        {/* On a phone the counts are this line. */}
        <span className="hidden truncate text-[0.72rem] text-muted-foreground tabular-nums @max-[40rem]/table:block">
          {num(c.sent)} sent
          {c.failed > 0 && <span className="text-warning"> · {num(c.failed)} not sent</span>} · last{' '}
          <Ago at={c.lastAt} />
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-3">
        <span className={BAR}>
          <span
            className={BAR_FILL}
            style={{ width: `${String(Math.max(1.5, (attempts / max) * 100))}%` }}
          />
        </span>
        <span className="w-10 flex-none text-right text-[0.8125rem] text-foreground tabular-nums @max-[40rem]/table:w-auto">
          {num(attempts)}
        </span>
      </span>
      <span className={NUM}>{num(c.sent)}</span>
      <span className={cn(NUM, c.failed > 0 && 'text-warning')}>
        {c.failed > 0 ? num(c.failed) : NONE}
      </span>
      <span className={cn(NUM, 'whitespace-nowrap')}>
        <Ago at={c.lastAt} />
      </span>
    </li>
  )
}
