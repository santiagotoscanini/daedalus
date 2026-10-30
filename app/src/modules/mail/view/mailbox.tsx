import { Ago } from '../../../components/ago'
import { AXIS, CAPTION, FOOT, NOTE, SUB } from '../../../components/tokens'
import { Board, Chip, type Column, Columns, Measures } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { BridgeFolder, Mailbox } from '../data/bridge'
import { InboxTable, SendersTable } from './mailbox-tables'

// Email › one account's mailbox, as the supervisor last read it over IMAP:
// thirty days of mail, who wrote most, the folders and labels, and what is in
// the inbox now. Each is a full-width row: their heights follow the mailbox,
// so no two of them would keep a flat bottom edge side by side.

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
      <SendersTable m={m} />
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
  const received = m.days.reduce((n, d) => n + d.received, 0)
  const sent = m.days.reduce((n, d) => n + d.sent, 0)
  const busiest = m.days.reduce<Mailbox['days'][number] | null>(
    (best, d) => (best === null || d.received > best.received ? d : best),
    null,
  )
  const atLeast = m.windowCapped ? 'at least ' : ''
  return (
    <Board
      title={owner === null ? 'Mail per day' : `Mail per day, ${owner}`}
      span={12}
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
          {/* The window's totals, read against the chart they sum rather than
              a band away from it. */}
          <Measures
            items={[
              { k: `Received, ${String(m.days.length)} days`, v: `${atLeast}${num(received)}` },
              { k: `Sent, ${String(m.days.length)} days`, v: `${atLeast}${num(sent)}` },
              ...(busiest === null || busiest.received === 0
                ? []
                : [
                    {
                      k: 'Busiest day',
                      v: `${num(busiest.received)} on ${busiest.day.slice(5)}`,
                    },
                  ]),
            ]}
          />
          <div className="flex flex-col gap-1">
            <p className={cn(SUB, 'mt-0')}>Received</p>
            <Columns
              points={m.days.map((d) => column(d.day, d.received, 'received'))}
              height={96}
            />
            <p className={cn(SUB, 'mt-1.5')}>Sent</p>
            <Columns points={m.days.map((d) => column(d.day, d.sent, 'sent'))} height={36} />
          </div>
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

/** Name · unread · messages, the two counts right-aligned in fixed tracks so they line up down a column. */
const FOLDER_ROW =
  'grid grid-cols-[minmax(0,1fr)_4.5rem_4rem] items-baseline gap-x-3 border-hairline border-b py-1.5 text-[0.8rem]'

function FolderRow({ f }: { f: BridgeFolder }) {
  const name = shortName(f.name)
  return (
    <div className={FOLDER_ROW}>
      <span className="min-w-0 truncate text-foreground" title={name}>
        {name}
      </span>
      <span className="text-right text-[0.75rem] text-foreground tabular-nums [font-weight:560]">
        {f.unseen > 0 ? `${num(f.unseen)} unread` : ''}
      </span>
      <span className="text-right text-muted-foreground tabular-nums">{num(f.messages)}</span>
    </div>
  )
}

/**
 * The folders as one list flowing down balanced columns: three on a wide
 * board, two, then one. A group's heading travels with its first row, so a
 * column never ends on a heading; every row carries its rule below, so each
 * column starts flush at the top.
 */
const FOLDER_COLUMNS =
  'columns-3 gap-x-10 @max-[52rem]/board:columns-2 @max-[30rem]/board:columns-1 [&>div]:break-inside-avoid'

function FoldersBoard({ m }: { m: Mailbox }) {
  if (m.folders.length === 0) return null
  const g = orderFolders(m.folders)
  const groups = [
    { title: null, folders: g.system },
    { title: 'Folders', folders: g.folder },
    { title: 'Labels', folders: g.label },
  ]
  return (
    <Board
      title="Folders and labels"
      span={12}
      aside={<span className={NOTE}>{num(m.folders.length)} in all</span>}
    >
      <div className={FOLDER_COLUMNS}>
        {groups.flatMap(({ title, folders }) =>
          folders.map((f, i) => (
            <div key={f.name}>
              {i === 0 && title !== null && <p className={cn(SUB, 'mt-3 mb-0.5')}>{title}</p>}
              <FolderRow f={f} />
            </div>
          )),
        )}
      </div>
      <p className={FOOT}>
        Messages in each, as IMAP counts them. A message wears every label it has and sits in one
        folder, and All Mail holds them all, so the counts overlap.
      </p>
    </Board>
  )
}
