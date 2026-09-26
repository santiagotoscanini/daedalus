// The Connection board: the server's own lines about its link to Anthropic,
// read back out of Loki for the last fortnight.
import type { RcEvent } from '../../lib/dashboard/claude'
import { since } from '../../lib/format'
import { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE } from '../tokens'
import { Board, Chip, type Tone } from '../viz'

const EVENT_TONE: Record<RcEvent['kind'], Tone> = {
  session: 'ok',
  drop: 'warn',
  reconnect: 'ok',
  refresh: 'muted',
  other: 'muted',
}

const EVENT_LABEL: Record<RcEvent['kind'], string> = {
  session: 'session',
  drop: 'drop',
  reconnect: 'reconnect',
  refresh: 'token',
  other: 'note',
}

export function ConnectionBoard({ events }: { events: RcEvent[] }) {
  return (
    <Board
      title="Connection"
      icon="logs"
      span={6}
      aside={<span className={NOTE}>last 14 days</span>}
    >
      {events.length === 0 ? (
        <p className={EMPTY}>
          Nothing in the window. Either the server has been up and connected throughout, or its
          journal has been rotated past. These lines are read back out of Loki.
        </p>
      ) : (
        <ul className={LIST}>
          {events.slice(0, 14).map((e) => (
            <EventRow key={`${String(e.at)}-${e.text}`} event={e} />
          ))}
        </ul>
      )}
      <p className={FOOT}>
        A <b>drop</b> is the server losing its link to Anthropic and backing off; it retries and the
        sessions survive, so a burst followed by a reconnect is the system working. Bursts landing
        at <span className={MONO}>:00</span> are the box rather than the network — myspeed's hourly
        speedtest saturates the uplink for a minute or two.
      </p>
    </Board>
  )
}

function EventRow({ event }: { event: RcEvent }) {
  return (
    <li className={ROW}>
      <Chip tone={EVENT_TONE[event.kind]}>{EVENT_LABEL[event.kind]}</Chip>
      <span className={ROW_MAIN}>{event.text}</span>
      <span className={ROW_SIDE}>{since((Date.now() - event.at) / 1000)}</span>
    </li>
  )
}
