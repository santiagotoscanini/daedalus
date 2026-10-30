import { Paperclip, Star } from 'lucide-react'
import { DAY_TIME, LocalTime } from '../../../components/ago'
import { SECTION_SPAN } from '../../../components/modules/parts'
import {
  CELL_MONO,
  CELL_QUIET,
  TABLE,
  TABLE_HEAD,
  TABLE_ROW,
  TABLE_ROW_DENSE,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { FOOT } from '../../../components/tokens'
import { cn } from '../../../lib/cn'
import { DASH, num } from '../../../lib/format'
import type { Mailbox, MailMessage, MailSender } from '../data/bridge'

// Email › the mailbox's two lists, as the house tables: who wrote most, and
// what is in the inbox. Every cell is one line; an address or a subject too
// long for its column ends in an ellipsis and is whole on the hover, so the
// rows keep one height and the columns one width.

/** No figure: a quiet dash, so a blank cell never reads as a rendering fault. */
const NONE = <span className="text-muted-foreground/50">{DASH}</span>

/**
 * Sender, address, then the count with its bar. On a phone the address drops
 * under the name and the bar goes.
 */
const SENDER_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(9rem,0.7fr)]',
  '@max-[40rem]/table:grid-cols-[minmax(0,1fr)_auto] @max-[40rem]/table:gap-x-3 @max-[40rem]/table:[&>.wide]:hidden',
)

/** The bar is the comparison this table exists to make, so it is the one drawn thing in a row. */
const BAR =
  'block h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-foreground/[0.08] @max-[40rem]/table:hidden'
const BAR_FILL =
  'block h-full origin-left animate-[bar-grow_600ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-full bg-muted-foreground opacity-60 motion-reduce:animate-none'

export function SendersTable({ m }: { m: Mailbox }) {
  if (m.topSenders.length === 0) return null
  const max = Math.max(1, ...m.topSenders.map((s) => s.count))
  return (
    <TableSection
      title="Who wrote most"
      aside={`${String(m.days.length)} days`}
      className={SECTION_SPAN[12]}
    >
      <ul className={TABLE} aria-label="Who wrote most">
        <li className={cn(SENDER_GRID, TABLE_HEAD)}>
          <span>Sender</span>
          <span className="wide">Address</span>
          <span className="text-right">Messages</span>
        </li>
        {m.topSenders.map((s) => (
          <SenderRow key={s.address} s={s} max={max} />
        ))}
      </ul>
      <p className={FOOT}>Mail received in the window, counted by the address it came from.</p>
    </TableSection>
  )
}

function SenderRow({ s, max }: { s: MailSender; max: number }) {
  const named = s.name !== ''
  return (
    <li className={cn(SENDER_GRID, TABLE_ROW)}>
      <span className="min-w-0">
        <span
          className={cn(
            'block truncate text-[0.8125rem] text-foreground',
            !named && 'font-mono text-[0.76rem]',
          )}
          title={named ? s.name : s.address}
        >
          {named ? s.name : s.address}
        </span>
        {/* On a phone the address is this line. */}
        {named && (
          <span
            className="hidden truncate font-mono text-[0.7rem] text-muted-foreground @max-[40rem]/table:block"
            title={s.address}
          >
            {s.address}
          </span>
        )}
      </span>
      <span className={cn(CELL_MONO, 'wide')} title={named ? s.address : undefined}>
        {named ? s.address : NONE}
      </span>
      <span className="flex min-w-0 items-center gap-3">
        <span className={BAR}>
          <span
            className={BAR_FILL}
            style={{ width: `${String(Math.max(1.5, (s.count / max) * 100))}%` }}
          />
        </span>
        <span className="w-10 flex-none text-right text-[0.8125rem] text-foreground tabular-nums @max-[40rem]/table:w-auto">
          {num(s.count)}
        </span>
      </span>
    </li>
  )
}

/**
 * Received · from · subject · marks, in fixed tracks. On a narrow table the
 * sender and the time drop under the subject.
 */
const INBOX_GRID = cn(
  'grid items-center gap-x-5 px-5',
  'grid-cols-[7.5rem_minmax(0,1fr)_minmax(0,2fr)_3.5rem]',
  '@max-[44rem]/table:grid-cols-[minmax(0,1fr)_3.5rem] @max-[44rem]/table:gap-x-3 @max-[44rem]/table:[&>.wide]:hidden',
)

export function InboxTable({ m, owner }: { m: Mailbox; owner: string | null }) {
  if (m.recent.length === 0) return null
  const inbox = m.folders.find((f) => f.name === 'INBOX')
  return (
    <TableSection
      title={owner === null ? 'Inbox' : `Inbox, ${owner}`}
      aside={
        inbox === undefined
          ? `newest ${num(m.recent.length)}`
          : `newest ${num(m.recent.length)} of ${num(inbox.messages)} · ${num(inbox.unseen)} unread`
      }
      className={SECTION_SPAN[12]}
    >
      <ul className={TABLE} aria-label="Inbox">
        <li className={cn(INBOX_GRID, TABLE_HEAD)}>
          <span className="wide">Received</span>
          <span className="wide">From</span>
          <span>Subject</span>
          <span className="text-right">Marks</span>
        </li>
        {m.recent.map((msg, i) => (
          <Message key={`${msg.date}-${String(i)}`} msg={msg} />
        ))}
      </ul>
    </TableSection>
  )
}

function Message({ msg }: { msg: MailMessage }) {
  const from = msg.fromName === '' ? msg.fromAddress : msg.fromName
  const subject = msg.subject === '' ? '(no subject)' : msg.subject
  return (
    <li className={cn(INBOX_GRID, TABLE_ROW_DENSE)}>
      <span className={cn(CELL_QUIET, 'wide whitespace-nowrap')}>
        <LocalTime at={msg.date} opts={DAY_TIME} />
      </span>
      <span className="wide min-w-0 truncate text-[0.8rem]" title={msg.fromAddress}>
        {from}
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            'block truncate text-[0.8125rem]',
            msg.unread ? 'text-foreground [font-weight:600]' : 'text-subdued',
            msg.subject === '' && 'text-muted-foreground',
          )}
          title={subject}
        >
          {subject}
        </span>
        {/* On a narrow table the sender and the time are this line. */}
        <span
          className={cn(CELL_QUIET, 'hidden truncate @max-[44rem]/table:block')}
          title={msg.fromAddress}
        >
          {from} · <LocalTime at={msg.date} opts={DAY_TIME} />
        </span>
      </span>
      <span className="flex items-center justify-end gap-1.5 text-muted-foreground">
        {msg.unread && (
          <span className="size-1.5 rounded-full bg-foreground" role="img" aria-label="unread" />
        )}
        {msg.flagged && <Star size={13} aria-label="flagged" className="fill-current" />}
        {msg.attachments && <Paperclip size={13} aria-label="attachments" />}
      </span>
    </li>
  )
}
