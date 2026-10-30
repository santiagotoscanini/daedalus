import { KeyValue } from '../../../components/modules/parts'
import { CAPTION, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, Chip, Measures } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num, since } from '../../../lib/format'
import type { Overview } from './shared'

// Email › the alert relay: who the box's mail is from and to, the server it
// leaves through, and what the last month of attempts says about it. The
// same reading as Monitoring › Alerts, whose failed-sends table is the
// drill-down this board leaves out.

type Relay = Overview['relay']

export function RelayBoard({ relay: r }: { relay: Relay }) {
  const id = r.identity
  const lastFailure = r.failures[0]
  const failed = r.failed30d ?? 0

  return (
    <Board
      title={r.failing ? 'Alert relay failing' : 'Alert relay'}
      span={12}
      aside={
        r.failing ? (
          <Chip tone="bad">
            {num(failed)} failed send{failed === 1 ? '' : 's'} in 30 days
          </Chip>
        ) : (
          <span className={NOTE}>{r.sent30d === null ? DASH : num(r.sent30d)} sent in 30 days</span>
        )
      }
    >
      <Measures
        items={[
          { k: 'Sent', v: num(r.sent30d) },
          // Recovered failures are history: plain. Only a current one is red.
          { k: 'Failed', v: num(r.failed30d), ...(r.failing ? { tone: 'bad' as const } : {}) },
          {
            k: 'Last success',
            v:
              r.lastSend === null
                ? r.sent30d === null
                  ? DASH
                  : 'none'
                : since(r.lastSend.agoSeconds),
          },
          {
            k: 'Last failure',
            v:
              lastFailure === undefined
                ? r.failed30d === null
                  ? DASH
                  : 'none'
                : since(lastFailure.agoSeconds),
          },
        ]}
      />
      {r.sent30d === null && (
        <p className={CAPTION}>Loki did not answer, so the delivery counts are unknown.</p>
      )}
      {lastFailure !== undefined && (
        <p className={cn(CAPTION, r.failing && 'text-danger/90')}>
          <span className={MONO}>{lastFailure.unit}</span>: {lastFailure.error}
        </p>
      )}
      <KeyValue
        rows={[
          {
            k: 'From',
            v: id === null || id.sender === '' ? DASH : <span className={MONO}>{id.sender}</span>,
          },
          {
            k: 'To',
            v: id === null || id.alertTo === '' ? DASH : <span className={MONO}>{id.alertTo}</span>,
          },
          {
            k: 'Relay',
            v:
              id === null || id.smtpHost === '' ? (
                DASH
              ) : (
                <span className={MONO}>
                  {id.smtpHost}
                  {id.smtpPort === null ? '' : `:${String(id.smtpPort)}`}
                </span>
              ),
          },
        ]}
      />
      <p className={FOOT}>
        Every alert the box mails leaves through this one SMTP account, by way of{' '}
        <span className={MONO}>sendmail</span>. The counts are read back from the relay&rsquo;s own
        log, one line per attempt, over the last 30 days. A relay that stops working makes the box
        quieter, because the warning would travel the path that broke: a red reading here may be the
        only notice you get. A long gap since the last success is normal on a healthy box. Grafana
        sends its own alerts through its SMTP client, so they are not counted. Monitoring &rsaquo;
        Alerts lists each failed send.
      </p>
    </Board>
  )
}
