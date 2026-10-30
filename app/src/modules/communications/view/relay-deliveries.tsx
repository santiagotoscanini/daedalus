import { useState } from 'react'
import { DAY_TIME, LocalTime } from '../../../components/ago'
import { QuietState, SECTION_SPAN, TABLE_NONE } from '../../../components/modules/parts'
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
import type { RelayDelivery, RelayLog } from '../../../lib/dashboard/mail-relay'
import { bytes, num } from '../../../lib/format'
import { unitName } from './shared'

// Communications › every delivery msmtp logged in the window, newest first: when,
// which unit was sending (and, for a failure notice, which unit it was
// about), to whom, how big, what the relay answered, and how it ended.

/** Rows before the rest fold. */
const SHOWN = 12

/**
 * When · caller · recipients · size · reply · outcome. On a narrow table the
 * recipients and size drop under the caller and the reply goes; on a phone
 * the time joins them, leaving the caller and the outcome.
 */
const GRID =
  'grid items-start gap-x-5 px-5 grid-cols-[7.5rem_minmax(0,1.1fr)_minmax(0,1fr)_4.5rem_minmax(0,1.3fr)_4.5rem] @max-[56rem]/table:grid-cols-[6.5rem_minmax(0,1fr)_4.5rem] @max-[56rem]/table:gap-x-3 @max-[56rem]/table:[&>.wide]:hidden @max-[36rem]/table:grid-cols-[minmax(0,1fr)_4.5rem] @max-[36rem]/table:[&>.when]:hidden'

const NARROW = 'hidden @max-[56rem]/table:block'
const PHONE = 'hidden @max-[36rem]/table:inline'

/** An identifier on one line, cut with an ellipsis: the whole of it is on the hover. */
const ID_MONO = 'min-w-0 truncate py-1 font-mono text-[0.72rem] text-muted-foreground'

export function DeliveriesTable({
  log,
  failing,
  window,
}: {
  log: RelayLog
  failing: boolean
  window: number
}) {
  const [all, setAll] = useState(false)
  const rows = log.deliveries
  const shown = all ? rows : rows.slice(0, SHOWN)
  const newestFailure = rows.find((d) => !d.ok)

  return (
    <TableSection
      title="Deliveries"
      aside={
        rows.length === 0
          ? undefined
          : `${log.capped ? 'at least ' : ''}${num(rows.length)} in ${num(window)} days, newest first`
      }
      className={SECTION_SPAN[12]}
    >
      {rows.length === 0 ? (
        <p className={TABLE_NONE}>msmtp logged no delivery in {num(window)} days.</p>
      ) : (
        <ul className={TABLE} aria-label="Deliveries">
          <li className={cn(GRID, TABLE_HEAD)}>
            <span className="when">When</span>
            <span>Sent by</span>
            <span className="wide">To</span>
            <span className="wide text-right">Size</span>
            <span className="wide">Relay&rsquo;s reply</span>
            <span className="text-right">Outcome</span>
          </li>
          {shown.map((d, i) => (
            <Row
              key={`${String(d.at)}-${d.unit}-${String(i)}`}
              d={d}
              current={failing && d === newestFailure}
            />
          ))}
          {rows.length > SHOWN && (
            <TableMore
              open={all}
              onToggle={() => {
                setAll((v) => !v)
              }}
              more={`${num(rows.length - SHOWN)} older`}
              less={`Show the newest ${String(SHOWN)}`}
            />
          )}
        </ul>
      )}
      <p className={FOOT}>
        One row per line msmtp wrote, filed by journald under the unit that ran it. The reply is the
        relay&rsquo;s last SMTP answer; the code after it is the provider&rsquo;s own message id.
      </p>
    </TableSection>
  )
}

function Caller({ d }: { d: RelayDelivery }) {
  return (
    <span className="block truncate font-mono text-[0.76rem] text-foreground" title={d.unit}>
      {d.about === null ? (
        unitName(d.unit)
      ) : (
        <>
          {d.about} <span className="font-sans text-[0.75rem] text-muted-foreground">failed</span>
        </>
      )}
    </span>
  )
}

function Row({ d, current }: { d: RelayDelivery; current: boolean }) {
  const to = d.recipients.join(', ')
  const reply = d.smtpMessage ?? (d.smtpStatus === null ? null : String(d.smtpStatus))
  return (
    <li className={cn(GRID, TABLE_ROW_DENSE)}>
      <span className={cn(CELL_QUIET, 'when py-1')}>
        <LocalTime at={d.at} opts={DAY_TIME} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 py-1">
        <Caller d={d} />
        {/* On a narrow table the columns it lost are this line. */}
        <span className={cn(CELL_QUIET, NARROW, 'truncate')} title={to}>
          <span className={PHONE}>
            <LocalTime at={d.at} opts={DAY_TIME} />
            {' · '}
          </span>
          {[to, d.bytes === null ? null : bytes(d.bytes)]
            .filter((x) => x !== null && x !== '')
            .join(' · ')}
        </span>
        {d.error !== null && (
          <span
            className={cn(
              'text-[0.75rem] [overflow-wrap:break-word]',
              current ? 'text-danger/90' : 'text-muted-foreground',
            )}
          >
            {d.error}
          </span>
        )}
      </span>
      <span className={cn(ID_MONO, 'wide')} title={to}>
        {to}
      </span>
      <span className={cn(CELL_QUIET, 'wide py-1 text-right')}>
        {d.bytes === null ? null : bytes(d.bytes)}
      </span>
      <span className={cn(ID_MONO, 'wide')} title={reply ?? undefined}>
        {reply}
      </span>
      <span className="py-1 text-right">
        {d.ok ? (
          <QuietState>sent</QuietState>
        ) : (
          <Chip tone={current ? 'bad' : 'warn'} title={d.exitCode}>
            not sent
          </Chip>
        )}
      </span>
    </li>
  )
}
