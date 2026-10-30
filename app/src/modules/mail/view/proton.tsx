import { Ago } from '../../../components/ago'
import { useLiveValue } from '../../../components/poll'
import { Changelog } from '../../../components/release-notes'
import { compareOf, ServiceHead, verdictOf } from '../../../components/service-head'
import { FOOT, LIVE } from '../../../components/tokens'
import { BoardGrid, Chip, Pulse, Stat, StatStrip } from '../../../components/viz'
import { num } from '../../../lib/format'
import { fetchBridgeReportFn } from '../../../server/mail'
import type { BridgeReport } from '../data/bridge'
import { AccountsBoard } from './accounts'
import { BridgeBoard, SettingsBoard } from './bridge'
import { BridgeLogsTable } from './bridge-logs'
import { EventsTable } from './events'
import { MailboxBoards } from './mailbox'
import { busy, type Proton } from './shared'

// Email › the Proton Mail tab: Bridge as its supervisor reports it, the
// mailbox it serves, the container around it, and what it logged.

/** While a sync moves or Bridge starts: the supervisor flushes a change within a second. */
const BUSY_MS = 3_000
/** Otherwise its heartbeat, which is also how quickly a stopped container shows. */
const IDLE_MS = 30_000

const MB = 1024 * 1024
const mb = (b: number): string => num(Math.round(b / MB))

export function ProtonView({ data: d }: { data: Proton }) {
  // The status file, kept live: re-read every few seconds while something
  // moves, every half minute otherwise. Only the file — the release gap, the
  // container's metrics and the logs do not change while you watch.
  const report = useLiveValue<BridgeReport>(
    d.report,
    () => fetchBridgeReportFn(),
    (r) => (busy(r) ? BUSY_MS : IDLE_MS),
    () => true,
  )
  const s = report.reporting ? report.status : null
  const users = s?.users ?? []

  return (
    <>
      <ServiceHead
        logo="/icon-proton-mail.svg"
        name="Proton Mail Bridge"
        version={d.gap.installed}
        versionNote={
          d.versionFrom === 'bridge' ? 'as Bridge reports it' : 'the build this box pins'
        }
        verdict={verdictOf(d.gap)}
        compare={compareOf(
          d.gap,
          d.versionFrom === 'bridge' ? 'as Bridge reports it' : 'the pinned build',
        )}
        lede="Proton’s encrypted mailbox, served on this box over local IMAP and SMTP."
        actions={<Reporting report={report} />}
      />
      <Strip d={d} report={report} />
      <BoardGrid>
        <AccountsBoard report={report} />
        <BridgeBoard report={report} />
        {users.map((u) =>
          u.mailbox === null ? null : (
            <MailboxBoards
              key={u.id}
              mailbox={u.mailbox}
              owner={users.length > 1 ? u.username : null}
            />
          ),
        )}
        {s !== null && <SettingsBoard status={s} />}
        {d.logs !== null && <BridgeLogsTable logs={d.logs} />}
        {report.status !== null && <EventsTable events={report.status.events} />}
        <Changelog
          gap={d.gap}
          span={12}
          foot={
            <p className={FOOT}>
              Proton&rsquo;s own releases, from the running version to the newest. Proton retires
              old versions on its servers without notice, and a retired version has every request
              refused until it is updated (the <b>Update required</b> event).
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/** The header's reading: alive (with when it last said so), starting, or silent. */
function Reporting({ report }: { report: BridgeReport }) {
  const s = report.status
  if (!report.reporting || s === null) return <Chip tone="bad">not reporting</Chip>
  if (s.phase === 'starting') return <Chip tone="info">starting</Chip>
  return (
    <span className={LIVE}>
      <Pulse on={busy(report)} tone="accent" />
      updated <Ago at={s.updatedAt} />
    </span>
  )
}

/** The mailbox's totals and the container's, each cell there only when its reading is. */
function Strip({ d, report }: { d: Proton; report: BridgeReport }) {
  const boxes = (report.reporting ? (report.status?.users ?? []) : []).flatMap((u) =>
    u.mailbox === null ? [] : [u.mailbox],
  )
  const inbox = boxes.flatMap((m) => m.folders.filter((f) => f.name === 'INBOX'))
  const days = boxes.flatMap((m) => m.days)
  const partial = boxes.some((m) => m.windowCapped) ? 'at least ' : ''
  const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((n, x) => n + f(x), 0)
  const { cpu, memory, oomKills: oom } = d.resources

  const cells = [
    inbox.length > 0 && (
      <Stat
        key="inbox"
        label="Inbox"
        value={num(sum(inbox, (f) => f.messages))}
        sub={`${num(sum(inbox, (f) => f.unseen))} unread`}
      />
    ),
    days.length > 0 && (
      <Stat
        key="received"
        label="Received"
        value={num(sum(days, (x) => x.received))}
        sub={`${partial}in 30 days`}
      />
    ),
    days.length > 0 && (
      <Stat
        key="sent"
        label="Sent"
        value={num(sum(days, (x) => x.sent))}
        sub={`${partial}in 30 days`}
      />
    ),
    cpu.used !== null && (
      <Stat
        key="cpu"
        label="CPU"
        value={cpu.used.toFixed(2)}
        unit={cpu.limit === null ? 'cores' : `of ${String(cpu.limit)}`}
        spark={cpu.spark}
        title="cgroup v2, 60-second resolution, 5-minute rate"
      />
    ),
    memory.used !== null && (
      <Stat
        key="memory"
        label="Memory"
        value={mb(memory.used)}
        unit={memory.limit === null ? 'MB' : `of ${mb(memory.limit)} MB`}
        spark={memory.spark}
        title="memory.current counts page cache: a container reading its store sits near its limit and is fine"
      />
    ),
    oom !== null && (
      <Stat
        key="oom"
        label="OOM kills"
        value={num(oom)}
        tone={oom > 0 ? 'bad' : undefined}
        title="The kernel killing a process for the memory limit: the reading that says the limit is too tight"
      />
    ),
  ].filter((c) => c !== false)
  return cells.length === 0 ? null : <StatStrip>{cells}</StatStrip>
}
