import { Ago } from '../../../components/ago'
import { EMPTY } from '../../../components/tokens'
import { BoardGrid, Stat, StatStrip } from '../../../components/viz'
import { num } from '../../../lib/format'
import { DeliveriesTable } from './relay-deliveries'
import { CallersTable, FrequencyBoard } from './relay-frequency'
import { SmtpBoard, UsersBoard } from './relay-setup'
import type { Relay } from './shared'

// Email › the relay tab: what the account the box mails through has sent,
// how often, for whom, and how it is set up. The counts are msmtp's own log
// lines over the window, read back from Loki.

export function RelayView({ data: d }: { data: Relay }) {
  const log = d.log
  const lastSent = log?.deliveries.find((x) => x.ok)
  const lastFailed = log?.deliveries.find((x) => !x.ok)
  const sent = d.relay.sent30d
  const failed = d.relay.failed30d ?? 0
  const lower = log?.capped === true ? 'at least ' : ''

  return (
    <>
      {sent === null ? (
        <p className={EMPTY}>Loki did not answer, so the relay&rsquo;s deliveries are unknown.</p>
      ) : (
        <StatStrip>
          <Stat label="Sent" value={num(sent)} sub={`${lower}in ${String(d.windowDays)} days`} />
          <Stat
            label="Failed"
            value={num(failed)}
            tone={d.relay.failing ? 'bad' : undefined}
            sub={
              failed === 0
                ? undefined
                : d.relay.failing
                  ? 'newer than the last success'
                  : 'since recovered'
            }
          />
          <Stat
            label="Per week"
            value={num((sent / d.windowDays) * 7, 1)}
            sub={`${String(d.windowDays)}-day average`}
          />
          {lastSent !== undefined && <Stat label="Last sent" value={<Ago at={lastSent.at} />} />}
          {lastFailed !== undefined && (
            <Stat
              label="Last failure"
              value={<Ago at={lastFailed.at} />}
              tone={d.relay.failing ? 'bad' : undefined}
            />
          )}
        </StatStrip>
      )}
      <BoardGrid>
        {log !== null && (
          <FrequencyBoard days={d.days} total={log.deliveries.length} window={d.windowDays} />
        )}
        <SmtpBoard d={d} />
        {log !== null && <CallersTable callers={d.callers} window={d.windowDays} />}
        <UsersBoard d={d} />
        {log !== null && (
          <DeliveriesTable log={log} failing={d.relay.failing} window={d.windowDays} />
        )}
      </BoardGrid>
    </>
  )
}
