import { useState } from 'react'
import { Ago } from '../../../components/ago'
import { SECTION_SPAN, TABLE_NONE } from '../../../components/modules/parts'
import {
  CELL_QUIET,
  TABLE,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
  TableMore,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { FOOT } from '../../../components/tokens'
import { Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { BridgeEvent } from '../data/bridge'
import { EVENT } from './shared'

// Communications › Bridge's recent events: what it said happened, newest first. The
// ordinary ones (a sync starting, the network coming back) are plain rows;
// the ones that stop mail wear their tone.

/** Rows before the rest fold. */
const EVENTS_SHOWN = 6

/** Event · detail · when. The detail drops under the event on a narrow table. */
const EVENT_GRID =
  'grid items-start gap-x-6 px-5 grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)_6rem] @max-[40rem]/table:grid-cols-[minmax(0,1fr)_auto] @max-[40rem]/table:gap-x-3 @max-[40rem]/table:[&>.detail]:hidden'

export function EventsTable({ events }: { events: BridgeEvent[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? events : events.slice(0, EVENTS_SHOWN)

  return (
    <TableSection
      title="Bridge events"
      aside={events.length === 0 ? undefined : `${num(events.length)}, newest first`}
      className={SECTION_SPAN[12]}
    >
      {events.length === 0 ? (
        <p className={TABLE_NONE}>Nothing has happened since Bridge started.</p>
      ) : (
        <ul className={TABLE} aria-label="Bridge events">
          <li className={cn(EVENT_GRID, TABLE_HEAD)}>
            <span>Event</span>
            <span className="detail">Detail</span>
            <span className="text-right">When</span>
          </li>
          {shown.map((e, i) => (
            <EventRow key={`${e.at}-${e.kind}-${String(i)}`} e={e} />
          ))}
          {events.length > EVENTS_SHOWN && (
            <TableMore
              open={all}
              onToggle={() => {
                setAll((v) => !v)
              }}
              more={`${num(events.length - EVENTS_SHOWN)} older`}
              less={`Show the newest ${String(EVENTS_SHOWN)}`}
            />
          )}
        </ul>
      )}
      <p className={FOOT}>
        The supervisor keeps the last 30 and starts the list again with each container start. A
        tinted row needs someone to act; the rest is the ordinary history of a running Bridge.
      </p>
    </TableSection>
  )
}

function EventRow({ e }: { e: BridgeEvent }) {
  const known = EVENT[e.kind]
  const label = known?.label ?? e.kind
  return (
    <li className={cn(EVENT_GRID, TABLE_ROW_DENSE)}>
      <span className="flex min-w-0 flex-col py-1">
        <span>
          {known?.tone === undefined ? (
            <span className="text-foreground">{label}</span>
          ) : (
            <Chip tone={known.tone}>{label}</Chip>
          )}
        </span>
        {/* On a phone the detail is this line, wrapping rather than cut. */}
        {e.detail !== '' && (
          <span className="hidden text-[0.75rem] text-muted-foreground [overflow-wrap:break-word] @max-[40rem]/table:block">
            {e.detail}
          </span>
        )}
      </span>
      <span className={cn(CELL_QUIET, 'detail py-1 [overflow-wrap:break-word]')}>{e.detail}</span>
      <span className={cn(CELL_QUIET, 'py-1 text-right')}>
        <Ago at={e.at} />
      </span>
    </li>
  )
}
