import { useLiveValue } from '../../../components/poll'
import { Changelog } from '../../../components/release-notes'
import { FOOT } from '../../../components/tokens'
import { BoardGrid } from '../../../components/viz'
import { fetchBridgeReportFn } from '../../../server/mail'
import type { BridgeReport } from '../data/bridge'
import { AccountsBoard } from './accounts'
import { BridgeBoard } from './bridge'
import { EventsTable } from './events'
import { RelayBoard } from './relay'
import { type Bridge, busy, type Overview } from './shared'

// Email › Overview: Proton Mail Bridge, when the box runs it, then the relay
// every box has, then Bridge's release notes as the reference at the foot.

/** While a sync moves or Bridge starts: the supervisor flushes a change within a second. */
const BUSY_MS = 3_000
/** Otherwise its heartbeat, which is also how quickly a stopped container shows. */
const IDLE_MS = 30_000

export function OverviewView({ data: d }: { data: Overview }) {
  return (
    <BoardGrid>
      {d.bridge !== null && <BridgeBoards bridge={d.bridge} />}
      <RelayBoard relay={d.relay} />
      {d.bridge !== null && (
        <Changelog
          gap={d.bridge.gap}
          span={12}
          foot={
            <p className={FOOT}>
              Proton&rsquo;s own releases, from the running version to the newest. Proton retires
              old versions on its servers without notice and publishes no support window. A retired
              version has every request refused until it is updated (the <b>Update required</b>{' '}
              event), so a long gap here can stop mail.
            </p>
          }
        />
      )}
    </BoardGrid>
  )
}

/**
 * The status file, kept live: re-read every few seconds while something
 * moves, every half minute otherwise. Only the file — the loader's release
 * gap does not change while you watch.
 */
function BridgeBoards({ bridge }: { bridge: Bridge }) {
  const report = useLiveValue<BridgeReport>(
    bridge.report,
    () => fetchBridgeReportFn(),
    (r) => (busy(r) ? BUSY_MS : IDLE_MS),
    () => true,
  )
  return (
    <>
      <AccountsBoard report={report} />
      <BridgeBoard bridge={bridge} report={report} />
      {report.status !== null && <EventsTable events={report.status.events} />}
    </>
  )
}
