import { useState } from 'react'
import { Ago } from '../../../components/ago'
import { AXIS, FOOT, NOTE } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Board, type Column, Columns, Measures, RankRow } from '../../../components/viz'
import { num } from '../../../lib/format'
import type { RelayCaller, RelayDay } from '../data/relay'
import { unitName } from './shared'

// Email › the relay's rhythm: a column per day, and which units sent.

/** Callers ranked before the rest fold. */
const CALLERS_SHOWN = 8

const RANKS = 'm-0 flex list-none flex-col gap-0.5 p-0'

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
    display: `${num(d.sent)} sent${d.failed > 0 ? ` · ${num(d.failed)} failed` : ''}`,
    flag: d.failed > 0,
  }))
  const first = days[0]?.day.slice(5)
  const last = days[days.length - 1]?.day.slice(5)

  return (
    <Board
      title="Deliveries per day"
      span={8}
      aside={
        <span className={NOTE}>
          {num(total)} in {num(window)} days
        </span>
      }
    >
      <Columns points={points} height={96} empty={`Nothing sent in ${String(window)} days.`} />
      {total > 0 && (
        <p className={AXIS}>
          <span>{first}</span>
          <span>deliveries per day</span>
          <span>{last}</span>
        </p>
      )}
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
      <p className={FOOT}>
        One column per day of the box&rsquo;s own calendar, counting every attempt msmtp logged. A
        red rule under a column marks a day with a failed delivery.
      </p>
    </Board>
  )
}

/** A unit as the ranking names it: a failure notice by the unit it reported. */
function callerName(c: RelayCaller): { name: string; note: string | null } {
  if (c.about !== null) {
    return { name: `${c.about} failed`, note: `${unitName(c.unit)}: the notice of this failure` }
  }
  return { name: unitName(c.unit), note: null }
}

export function CallersTable({ callers, window }: { callers: RelayCaller[]; window: number }) {
  const [all, setAll] = useState(false)
  const shown = all ? callers : callers.slice(0, CALLERS_SHOWN)
  const max = Math.max(1, ...callers.map((c) => c.sent + c.failed))

  return (
    <Board
      title="Who sent"
      span={6}
      aside={
        callers.length === 0 ? undefined : <span className={NOTE}>{num(callers.length)} units</span>
      }
    >
      {callers.length === 0 ? (
        <p className={NOTE}>Nothing sent in {num(window)} days.</p>
      ) : (
        <ul className={RANKS}>
          {shown.map((c) => {
            const { name, note } = callerName(c)
            return (
              <RankRow
                key={c.unit}
                name={name}
                note={note}
                value={c.sent + c.failed}
                max={max}
                meta={
                  <>
                    <span>{num(c.sent)} sent</span>
                    {c.failed > 0 && <span className="text-warning">{num(c.failed)} not sent</span>}
                    <span>
                      last <Ago at={c.lastAt} />
                    </span>
                  </>
                }
              />
            )
          })}
        </ul>
      )}
      {callers.length > CALLERS_SHOWN && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          aria-expanded={all}
          onClick={() => {
            setAll((v) => !v)
          }}
        >
          {all
            ? `Show the first ${String(CALLERS_SHOWN)}`
            : `${num(callers.length - CALLERS_SHOWN)} more`}
        </Button>
      )}
      <p className={FOOT}>
        Each unit msmtp ran inside, ranked by its attempts in the window. A failure notice is named
        by the unit whose failure it reported; hover the name for the notifier itself.
      </p>
    </Board>
  )
}
