import type { ReactNode } from 'react'
import { Ago } from '../../../components/ago'
import { QuietState } from '../../../components/modules/parts'
import { CAPTION, EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, Chip, Progress } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, duration, num, pct, until } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import type { BridgeAccount, BridgeReport } from '../data/bridge'
import { ACCOUNT_STATE } from './shared'

// Email › the Proton Mail accounts: each one Bridge holds — whether it is
// signed in, which addresses it serves, how full it is, and its sync.

/** Addresses shown before the rest fold into a count. */
const ADDRESSES_SHOWN = 3

/**
 * A completed sync shorter than this is Bridge's start-up check finding
 * nothing pending, which says nothing about how long a sync takes.
 */
const MEANINGFUL_SYNC_MS = 1_000

/** Storage fills toward a bounce: amber near the top, red at it. */
function storageTone(p: number | null): Tone {
  if (p === null) return 'muted'
  return p >= 95 ? 'bad' : p >= 85 ? 'warn' : 'muted'
}

export function AccountsBoard({ report }: { report: BridgeReport }) {
  const s = report.status
  const users = report.reporting && s !== null ? s.users : []
  const troubled = users.filter((u) => u.state !== 'connected')
  const worst = troubled.find((u) => u.state === 'signed-out') ?? troubled[0]

  return (
    <Board
      title={users.length > 1 ? `${num(users.length)} accounts` : 'Account'}
      span={8}
      aside={
        worst === undefined ? undefined : (
          <Chip tone={ACCOUNT_STATE[worst.state].tone}>
            {troubled.length === 1
              ? `${worst.username} ${ACCOUNT_STATE[worst.state].label}`
              : `${num(troubled.length)} accounts not connected`}
          </Chip>
        )
      }
    >
      {!report.reporting ? (
        <p className={EMPTY}>
          {report.error !== null
            ? `The status file could not be read: ${report.error}`
            : s === null
              ? 'Bridge has written no status since the box started.'
              : 'Bridge has been silent for over two minutes: the container is down or restarting.'}
        </p>
      ) : s?.phase === 'starting' && users.length === 0 ? (
        <p className={EMPTY}>Bridge is starting.</p>
      ) : users.length === 0 ? (
        <p className={EMPTY}>No account is signed in.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {users.map((u) => (
            <AccountRow key={u.id} u={u} />
          ))}
        </ul>
      )}
      <p className={FOOT}>
        Each account is one Proton login, served to mail clients on this box over IMAP and SMTP. A
        signed-out or locked account serves nothing until it signs in again, from a terminal on the
        box: <span className={MONO}>sudo proton-bridge-cli</span>, then{' '}
        <span className={MONO}>login</span>. Storage is the account&rsquo;s quota at Proton; a full
        one refuses new mail.
      </p>
    </Board>
  )
}

function AccountRow({ u }: { u: BridgeAccount }) {
  const state = ACCOUNT_STATE[u.state]
  const shown = u.addresses.slice(0, ADDRESSES_SHOWN)
  const more = u.addresses.length - shown.length
  const storagePct = u.totalBytes > 0 ? (u.usedBytes / u.totalBytes) * 100 : null

  return (
    <li className="flex min-w-0 flex-col gap-3 border-hairline border-t py-3.5 first:border-t-0 first:pt-0 last:pb-0">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 text-[0.875rem] text-foreground [font-weight:560] [overflow-wrap:anywhere]">
          {u.username}
        </span>
        <span className="flex items-center gap-2">
          {u.splitMode && <QuietState>split addresses</QuietState>}
          {u.state === 'connected' ? (
            <QuietState>{state.label}</QuietState>
          ) : (
            <Chip tone={state.tone}>{state.label}</Chip>
          )}
        </span>
      </div>
      {shown.length > 0 && (
        <p className={cn(CAPTION, '-mt-2 font-mono text-[0.75rem]')}>
          {shown.join(', ')}
          {more > 0 && <span className="font-sans"> and {num(more)} more</span>}
        </p>
      )}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 @max-[30rem]/board:grid-cols-1">
        <Meter
          label="Storage"
          value={
            u.totalBytes > 0
              ? `${bytes(u.usedBytes)} of ${bytes(u.totalBytes)}`
              : bytes(u.usedBytes)
          }
          pct={storagePct}
          tone={storageTone(storagePct)}
        />
        <SyncMeter u={u} />
      </div>
    </li>
  )
}

/**
 * The sync: moving (the bar, its percentage and Bridge's own estimate), or
 * the last one this supervisor saw finish — when, and how long it took when
 * that is a real number. Only a connected account syncs.
 */
function SyncMeter({ u }: { u: BridgeAccount }) {
  const { sync } = u
  const took =
    sync.lastDurationMs !== null && sync.lastDurationMs >= MEANINGFUL_SYNC_MS
      ? duration(sync.lastDurationMs / 1000)
      : null
  if (sync.state === 'syncing') {
    const left = sync.remainingMs > 0 ? ` · ${until(sync.remainingMs / 1000)} left` : ''
    return (
      <Meter
        label="Syncing"
        value={`${pct(sync.progress * 100)}${left}`}
        pct={sync.progress * 100}
        active
        sub={
          sync.startedAt === null && took === null ? undefined : (
            <>
              {sync.startedAt !== null && (
                <>
                  started <Ago at={sync.startedAt} />
                </>
              )}
              {sync.startedAt !== null && took !== null && ' · '}
              {took !== null && `the last one took ${took}`}
            </>
          )
        }
      />
    )
  }
  if (u.state !== 'connected' || sync.finishedAt === null) return null
  return (
    <Meter
      label="Synced"
      value={<Ago at={sync.finishedAt} />}
      pct={100}
      sub={took === null ? undefined : `took ${took}`}
    />
  )
}

/** A labelled reading over its bar, and a line under it when there is one to say. */
function Meter({
  label,
  value,
  pct: p,
  tone = 'muted',
  active = false,
  sub,
}: {
  label: string
  value: ReactNode
  pct: number | null
  tone?: Tone
  active?: boolean
  sub?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-[0.78rem]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground [overflow-wrap:anywhere]">{value}</span>
      </div>
      <Progress pct={p} tone={tone} active={active} />
      {sub !== undefined && <p className={cn(NOTE, 'm-0')}>{sub}</p>}
    </div>
  )
}
