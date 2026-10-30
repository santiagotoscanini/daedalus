import { Ago } from '../../../components/ago'
import { LogBoard, type LogNeighbour } from '../../../components/logs'
import { EMPTY, FOOT, MONO } from '../../../components/tokens'
import { BoardGrid, Stat, StatStrip } from '../../../components/viz'
import { num } from '../../../lib/format'
import { DeliveriesTable } from './relay-deliveries'
import { CallersTable, FrequencyBoard } from './relay-frequency'
import { SmtpBoard, UsersBoard } from './relay-setup'
import type { Relay } from './shared'

// Communications › the relay tab: what the account the box mails through has sent,
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
      {/* Full-width rows, the way the service tabs set a page: what the relay
          carried, who sent it and every attempt, then how the account is set up
          and who else uses it, then the log. Nothing here shares a row with a
          board of another height. */}
      <BoardGrid>
        {log !== null && (
          <FrequencyBoard days={d.days} total={log.deliveries.length} window={d.windowDays} />
        )}
        {log !== null && <CallersTable callers={d.callers} window={d.windowDays} />}
        {log !== null && (
          <DeliveriesTable log={log} failing={d.relay.failing} window={d.windowDays} />
        )}
        <SmtpBoard d={d} />
        <UsersBoard d={d} />
        <RelayLogs system={d.system} />
      </BoardGrid>
    </>
  )
}

/**
 * The relay keeps no log of its own: msmtp is a sendmail binary run inside
 * whichever unit had news, and journald files its line under that unit. The
 * failure notifier is the one sender that only ever mails, so its units are
 * the relay's stream (each line one attempt, and msmtp's own error when it
 * failed); smartd and ZED, the other two system mailers, are one fold away.
 */
function RelayLogs({ system }: { system: Relay['system'] }) {
  const neighbours: LogNeighbour[] = [
    ...(system.smartd === true
      ? [
          {
            source: { unit: 'smartd.service' },
            label: 'smartd',
            role: 'mails when a disk is failing',
            note: 'smartd hands a warning to sendmail and logs whether it went; msmtp’s line for that send lands here, not under the failure notices.',
          },
        ]
      : []),
    ...(system.zed === true
      ? [
          {
            source: { unit: 'zfs-zed.service' },
            label: 'ZFS ZED',
            role: 'mails on a pool fault or a scrub with errors',
            note: 'The ZFS event daemon’s zedlets mail through sendmail, so a pool notice and msmtp’s line for it land here.',
          },
        ]
      : []),
  ]
  return (
    <LogBoard
      source={{ units: 'notify-email@.+' }}
      title="Failure notice logs"
      neighbours={neighbours}
      foot={
        <p className={FOOT}>
          Every <span className={MONO}>notify-email@</span> unit: one per unit whose failure was
          mailed, and each of its lines one attempt as msmtp logged it, with the reason when the
          relay refused. The deliveries above read the same lines from every unit that sends.
        </p>
      }
    />
  )
}
