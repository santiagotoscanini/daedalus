// What both servers' tabs draw the same way: the comings and goings, as a table.

import { DAY_TIME, LocalTime } from '../../../components/ago'
import {
  BOARD_TABLE,
  BOARD_TABLE_HEAD,
  BOARD_TABLE_ROW,
  NUM_CELL,
} from '../../../components/modules/parts'
import { CELL_NAME, CELL_QUIET } from '../../../components/table'
import { EMPTY } from '../../../components/tokens'
import { cn } from '../../../lib/cn'

/* Who, what they did, when. The time is the numeric column. */
const EVENTS_GRID =
  'grid grid-cols-[minmax(0,1fr)_6rem_9rem] items-center gap-x-6 px-5 @max-[26rem]/table:grid-cols-[minmax(0,1fr)_4.5rem_7.5rem] @max-[26rem]/table:gap-x-3'

type GameEvent = { at: number; who: string; kind: 'join' | 'leave' }

/**
 * Arrivals and departures, newest first. An arrival is the reading, so it
 * keeps the text ink; a departure recedes. No chips: every row is one or the
 * other, and colouring both would colour the whole column.
 */
export function EventsTable({ events, empty }: { events: GameEvent[]; empty: string }) {
  if (events.length === 0) return <p className={EMPTY}>{empty}</p>
  return (
    <ul className={BOARD_TABLE}>
      <li className={cn(EVENTS_GRID, BOARD_TABLE_HEAD)}>
        <span>Player</span>
        <span>Event</span>
        <span className={NUM_CELL}>When</span>
      </li>
      {events.map((e) => (
        <li key={`${String(e.at)}-${e.who}-${e.kind}`} className={cn(EVENTS_GRID, BOARD_TABLE_ROW)}>
          <span className={CELL_NAME}>{e.who}</span>
          <span
            className={cn(
              'text-[0.8rem]',
              e.kind === 'join' ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            {e.kind === 'join' ? 'joined' : 'left'}
          </span>
          <span className={cn(CELL_QUIET, 'text-right whitespace-nowrap')}>
            <LocalTime at={e.at} opts={DAY_TIME} />
          </span>
        </li>
      ))}
    </ul>
  )
}
