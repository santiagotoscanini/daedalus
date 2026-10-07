// What both servers' tabs draw the same way: the comings and goings, as a
// table under its own heading, and the muted word a reading shows when there
// is nothing to read.

import type { ReactNode } from 'react'
import { DAY_TIME, LocalTime } from '../../../components/ago'
import { NUM_CELL, SECTION_SPAN, TABLE_NONE } from '../../../components/modules/parts'
import { CELL_QUIET, TABLE, TABLE_HEAD, TABLE_ROW } from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { cn } from '../../../lib/cn'

/* Who, what they did, when. The time is the numeric column. */
const EVENTS_GRID =
  'grid grid-cols-[minmax(0,1fr)_6rem_9rem] items-center gap-x-6 px-5 @max-[26rem]/table:grid-cols-[minmax(0,1fr)_4.5rem_7.5rem] @max-[26rem]/table:gap-x-3'

type GameEvent = { at: number; who: string; kind: 'join' | 'leave' }

/** A KPI with nothing behind it: a muted word at the same size as every
    other value in the strip — only the colour says it is not a reading. */
export function Unknown() {
  return <span className="text-muted-foreground">unknown</span>
}

/**
 * Arrivals and departures, newest first. An arrival is the reading, so it
 * keeps the text ink; a departure recedes. No chips: every row is one or the
 * other, and colouring both would colour the whole column.
 */
export function EventsSection({
  events,
  window,
  empty,
  children,
}: {
  events: GameEvent[]
  /** The window the log was read over, e.g. "last 7 days". */
  window: string
  empty: string
  /** The explanation, folded under the heading's ⓘ. */
  children?: ReactNode
}) {
  return (
    <TableSection title="Comings and goings" aside={window} className={SECTION_SPAN[12]}>
      {events.length === 0 ? (
        <p className={TABLE_NONE}>{empty}</p>
      ) : (
        <ul className={TABLE}>
          <li className={cn(EVENTS_GRID, TABLE_HEAD)}>
            <span>Player</span>
            <span>Event</span>
            <span className={NUM_CELL}>When</span>
          </li>
          {events.map((e) => (
            <li key={`${String(e.at)}-${e.who}-${e.kind}`} className={cn(EVENTS_GRID, TABLE_ROW)}>
              <span className="truncate text-[0.84rem] text-foreground">{e.who}</span>
              <span
                className={cn(
                  'text-[0.8rem]',
                  e.kind === 'join' ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {e.kind === 'join' ? 'joined' : 'left'}
              </span>
              <span className={cn(CELL_QUIET, NUM_CELL)}>
                <LocalTime at={e.at} opts={DAY_TIME} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {children}
    </TableSection>
  )
}
