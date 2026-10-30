import { Paperclip, Star } from 'lucide-react'
import { Ago, DAY_TIME, LocalTime } from '../../../components/ago'
import { SECTION_SPAN } from '../../../components/modules/parts'
import { CELL_QUIET, TABLE, TABLE_HEAD, TABLE_ROW_DENSE } from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { AXIS, CAPTION, FOOT, NOTE, SUB } from '../../../components/tokens'
import { Board, Chip, type Column, Columns, RankRow } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { BridgeFolder, Mailbox, MailMessage } from '../data/bridge'

// Email › one account's mailbox, as the supervisor last read it over IMAP:
// thirty days of mail, who wrote most, the folders and labels, and what is in
// the inbox now.

/** The system folders in the order a mail client lists them; anything else follows by name. */
const SYSTEM_ORDER = ['INBOX', 'Drafts', 'Sent', 'Starred', 'Archive', 'Spam', 'Trash', 'All Mail']

const systemRank = (name: string): number => {
  const i = SYSTEM_ORDER.indexOf(name)
  return i === -1 ? SYSTEM_ORDER.length : i
}

/** The folders in the order they are read: system first, then folders, then labels, each by name. */
function orderFolders(folders: BridgeFolder[]): Record<BridgeFolder['kind'], BridgeFolder[]> {
  const byName = (a: BridgeFolder, b: BridgeFolder) => a.name.localeCompare(b.name)
  return {
    system: folders
      .filter((f) => f.kind === 'system')
      .sort((a, b) => systemRank(a.name) - systemRank(b.name) || byName(a, b)),
    folder: folders.filter((f) => f.kind === 'folder').sort(byName),
    label: folders.filter((f) => f.kind === 'label').sort(byName),
  }
}

/** A folder's name as Proton shows it: without the `Folders/` or `Labels/` it is listed under. */
const shortName = (name: string): string => name.replace(/^(?:Folders|Labels)\//, '')

export function MailboxBoards({ mailbox: m, owner }: { mailbox: Mailbox; owner: string | null }) {
  return (
    <>
      <ActivityBoard m={m} owner={owner} />
      <SendersBoard m={m} />
      <FoldersBoard m={m} />
      <InboxTable m={m} owner={owner} />
    </>
  )
}

/** A day's column: the label is the month and day, the value one series. */
const column = (day: string, value: number, unit: string): Column => ({
  label: day.slice(5),
  value,
  display: `${num(value)} ${unit}`,
})

function ActivityBoard({ m, owner }: { m: Mailbox; owner: string | null }) {
  const first = m.days[0]?.day.slice(5)
  const last = m.days[m.days.length - 1]?.day.slice(5)
  return (
    <Board
      title={owner === null ? 'Mail per day' : `Mail per day, ${owner}`}
      span={8}
      aside={
        m.error === null ? (
          <span className={NOTE}>
            read <Ago at={m.readAt} />
          </span>
        ) : (
          <Chip tone="warn" title={m.error}>
            last read failed
          </Chip>
        )
      }
    >
      {m.error !== null && (
        <p className={CAPTION}>
          The last read failed: {m.error}. What follows is from the last one that worked.
        </p>
      )}
      {m.days.length > 0 && (
        <>
          <p className={cn(SUB, 'mt-0')}>Received{m.windowCapped ? ', at least' : ''}</p>
          <Columns points={m.days.map((d) => column(d.day, d.received, 'received'))} height={84} />
          <p className={cn(SUB, 'mt-1')}>Sent</p>
          <Columns points={m.days.map((d) => column(d.day, d.sent, 'sent'))} height={32} />
          <p className={AXIS}>
            <span>{first}</span>
            <span>by day of arrival</span>
            <span>{last}</span>
          </p>
        </>
      )}
      <p className={FOOT}>
        All Mail by the day each message arrived, on the box&rsquo;s own calendar. Sent is mail from
        one of the account&rsquo;s own addresses.
      </p>
    </Board>
  )
}

function SendersBoard({ m }: { m: Mailbox }) {
  if (m.topSenders.length === 0) return null
  const max = Math.max(1, ...m.topSenders.map((s) => s.count))
  return (
    <Board
      title="Who wrote most"
      span={4}
      spanMd={12}
      aside={<span className={NOTE}>30 days</span>}
    >
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {m.topSenders.map((s) => (
          <RankRow
            key={s.address}
            name={s.name === '' ? s.address : s.name}
            value={s.count}
            max={max}
            meta={<span className="[overflow-wrap:anywhere]">{s.address}</span>}
          />
        ))}
      </ul>
    </Board>
  )
}

const FOLDER_ROW =
  'grid grid-cols-[minmax(0,1fr)_auto_4.5rem] items-baseline gap-x-3 border-hairline border-t py-1.5 text-[0.8rem] first:border-t-0'

function FolderList({ folders }: { folders: BridgeFolder[] }) {
  return (
    <ul className="m-0 list-none p-0">
      {folders.map((f) => (
        <li key={f.name} className={FOLDER_ROW}>
          <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">
            {shortName(f.name)}
          </span>
          <span className="text-[0.75rem] text-foreground tabular-nums [font-weight:560]">
            {f.unseen > 0 ? `${num(f.unseen)} unread` : ''}
          </span>
          <span className="text-right text-muted-foreground tabular-nums">{num(f.messages)}</span>
        </li>
      ))}
    </ul>
  )
}

function FoldersBoard({ m }: { m: Mailbox }) {
  if (m.folders.length === 0) return null
  const g = orderFolders(m.folders)
  return (
    <Board title="Folders and labels" span={4} spanMd={12}>
      <FolderList folders={g.system} />
      {g.folder.length > 0 && (
        <>
          <p className={SUB}>Folders</p>
          <FolderList folders={g.folder} />
        </>
      )}
      {g.label.length > 0 && (
        <>
          <p className={SUB}>Labels</p>
          <FolderList folders={g.label} />
        </>
      )}
      <p className={FOOT}>
        Messages in each, as IMAP counts them. A message wears every label it has and sits in one
        folder, and All Mail holds them all, so the counts overlap.
      </p>
    </Board>
  )
}

/** When · from · subject · marks. On a narrow table the sender drops under the subject. */
const INBOX_GRID =
  'grid items-start gap-x-5 px-5 grid-cols-[7.5rem_minmax(0,0.8fr)_minmax(0,1.6fr)_3rem] @max-[44rem]/table:grid-cols-[minmax(0,1fr)_5.5rem] @max-[44rem]/table:gap-x-3 @max-[44rem]/table:[&>.wide]:hidden'

function InboxTable({ m, owner }: { m: Mailbox; owner: string | null }) {
  if (m.recent.length === 0) return null
  return (
    <TableSection
      title={owner === null ? 'Inbox' : `Inbox, ${owner}`}
      aside={`newest ${num(m.recent.length)}`}
      className={SECTION_SPAN[8]}
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
  return (
    <li className={cn(INBOX_GRID, TABLE_ROW_DENSE)}>
      <span className={cn(CELL_QUIET, 'wide py-1')}>
        <LocalTime at={msg.date} opts={DAY_TIME} />
      </span>
      <span
        className="wide min-w-0 py-1 text-[0.8rem] [overflow-wrap:anywhere]"
        title={msg.fromAddress}
      >
        {from}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 py-1">
        <span
          className={cn(
            'min-w-0 text-[0.8125rem] [overflow-wrap:anywhere]',
            msg.unread ? 'text-foreground [font-weight:600]' : 'text-subdued',
          )}
        >
          {msg.subject === '' ? '(no subject)' : msg.subject}
        </span>
        {/* On a narrow table the sender and the time are this line. */}
        <span className={cn(CELL_QUIET, 'hidden @max-[44rem]/table:block')}>
          {from} · <LocalTime at={msg.date} opts={DAY_TIME} />
        </span>
      </span>
      <span className="flex items-center justify-end gap-1.5 py-1.5 text-muted-foreground">
        {msg.unread && (
          <span className="size-1.5 rounded-full bg-foreground" role="img" aria-label="unread" />
        )}
        {msg.flagged && <Star size={13} aria-label="flagged" className="fill-current" />}
        {msg.attachments && <Paperclip size={13} aria-label="attachments" />}
      </span>
    </li>
  )
}
