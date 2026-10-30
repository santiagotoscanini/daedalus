import type { ReactNode } from 'react'
import { Ago } from '../../../components/ago'
import { KeyValue } from '../../../components/modules/parts'
import { CAPTION, FOOT, MONO, SUB } from '../../../components/tokens'
import { Board, Chip, Facts } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { Relay } from './shared'

// Email › the relay's setup: how msmtp reaches the account (as nix exported
// it), and everything on the box that sends with the same account.

/** How the connection is encrypted, in the words a reader expects. */
function security(tls: boolean | null, starttls: boolean | null): ReactNode {
  if (tls === null) return null
  if (!tls) return <Chip tone="warn">none</Chip>
  return starttls === true ? 'STARTTLS' : 'TLS from the first byte'
}

export function SmtpBoard({ d }: { d: Relay }) {
  const id = d.relay.identity
  if (id === null) return null
  const sec = security(id.tls, id.starttls)
  const rows: { k: string; v: ReactNode }[] = [
    ...(id.smtpHost === ''
      ? []
      : [
          {
            k: 'Server',
            v: (
              <span className={MONO}>
                {id.smtpHost}
                {id.smtpPort === null ? '' : `:${String(id.smtpPort)}`}
              </span>
            ),
          },
        ]),
    ...(sec === null ? [] : [{ k: 'Encryption', v: sec }]),
    ...(id.trustFile === null
      ? []
      : [{ k: 'Trusts', v: <span className={MONO}>{id.trustFile}</span> }]),
    ...(id.auth === true && id.user !== null
      ? [{ k: 'Signs in as', v: <span className={MONO}>{id.user}</span> }]
      : id.auth === false
        ? [{ k: 'Signs in', v: 'no' }]
        : []),
    ...(id.sender === '' ? [] : [{ k: 'From', v: <span className={MONO}>{id.sender}</span> }]),
    ...(id.alertTo === '' ? [] : [{ k: 'To', v: <span className={MONO}>{id.alertTo}</span> }]),
  ]
  if (rows.length === 0) return null

  return (
    <Board title="SMTP" span={4} spanMd={12}>
      <Facts list rows={rows} />
      <p className={FOOT}>
        msmtp is the box&rsquo;s <span className={MONO}>sendmail</span>: every program that mails
        through it sends from this account to this recipient. The settings are the ones nix wrote
        into msmtp&rsquo;s configuration.
      </p>
    </Board>
  )
}

const UNITS = 'm-0 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[0.75rem] text-muted-foreground'

export function UsersBoard({ d }: { d: Relay }) {
  const { system, own } = d
  const viaMsmtp: { k: string; v: ReactNode }[] = [
    ...(system.smartd === true ? [{ k: 'smartd', v: 'a disk failing, or about to' }] : []),
    ...(system.zed === true ? [{ k: 'ZFS ZED', v: 'a pool fault or a scrub with errors' }] : []),
    ...(system.onFailure.length === 0
      ? []
      : [
          {
            k: 'Failure notices',
            v: (
              <>
                {num(system.onFailure.length)} unit{system.onFailure.length === 1 ? '' : 's'} mail
                when they fail
                <span className={cn(UNITS, 'mt-1.5')}>
                  {system.onFailure.map((u) => (
                    <span key={u}>{u}</span>
                  ))}
                </span>
              </>
            ),
          },
        ]),
  ]
  const g = own.grafana
  const ownClient: { k: string; v: ReactNode }[] = [
    ...(g === null || (g.contactPoints === null && g.failed === null)
      ? []
      : [
          {
            k: 'Grafana',
            v: (
              <>
                {[
                  g.contactPoints === null
                    ? null
                    : `${num(g.contactPoints)} email contact point${g.contactPoints === 1 ? '' : 's'}`,
                  g.failed === null ? null : `${num(g.failed)} failed in ${num(d.windowDays)} days`,
                ]
                  .filter((x) => x !== null)
                  .join(' · ')}
                {g.lastFailure !== null && (
                  <span className={cn(CAPTION, 'mt-1 block')}>
                    <Ago at={g.lastFailure.at} />: {g.lastFailure.error}
                  </span>
                )}
              </>
            ),
          },
        ]),
    ...(own.healthchecks === null
      ? []
      : [
          {
            k: 'healthchecks',
            v: `${num(own.healthchecks.sent)} sent · ${num(own.healthchecks.failed)} failed in ${num(d.windowDays)} days`,
          },
        ]),
    ...(own.apps.length === 0
      ? []
      : [
          {
            k: 'Apps',
            v: (
              <span className={UNITS}>
                {own.apps.map((a) => (
                  <span key={a}>{a}</span>
                ))}
              </span>
            ),
          },
        ]),
  ]
  if (viaMsmtp.length === 0 && ownClient.length === 0) return null

  return (
    <Board title="Who uses this account" span={6}>
      {viaMsmtp.length > 0 && (
        <>
          <p className={cn(SUB, 'mt-0')}>Through sendmail</p>
          <KeyValue rows={viaMsmtp} />
        </>
      )}
      {ownClient.length > 0 && (
        <>
          <p className={SUB}>With an SMTP client of their own</p>
          <KeyValue rows={ownClient} />
        </>
      )}
      <p className={FOOT}>
        Failure notices are the units registered in{' '}
        <span className={MONO}>fleet.monitoredJobs</span> with email on. The counts beside Grafana
        and healthchecks come from their own logs over the same window; the apps listed have the
        relay switched on in their settings.
      </p>
    </Board>
  )
}
