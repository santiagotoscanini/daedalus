import type { ReactNode } from 'react'
import { Ago } from '../../../components/ago'
import { QuietState } from '../../../components/modules/parts'
import { CAPTION, EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, Chip, Progress } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, DASH, num, pct, until } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import type { BridgeAccount, BridgeReport } from '../data/bridge'
import { ACCOUNT_STATE } from './shared'

// Email › the Proton Mail board: each account Bridge holds — whether it is
// signed in, which addresses it serves, how full it is, and how far its
// sync has got.

/** Addresses shown before the rest fold into a count. */
const ADDRESSES_SHOWN = 3

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
      title="Proton Mail"
      span={8}
      aside={
        worst !== undefined ? (
          <Chip tone={ACCOUNT_STATE[worst.state].tone}>
            {troubled.length === 1
              ? `${worst.username} ${ACCOUNT_STATE[worst.state].label}`
              : `${num(troubled.length)} accounts not connected`}
          </Chip>
        ) : users.length > 1 ? (
          <span className={NOTE}>{num(users.length)} accounts</span>
        ) : undefined
      }
    >
      {!report.reporting ? (
        <p className={EMPTY}>Nothing current to show while Bridge is not reporting.</p>
      ) : s?.phase === 'starting' && users.length === 0 ? (
        <p className={EMPTY}>Bridge is starting. Its accounts appear once it has loaded them.</p>
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
        signed-out or locked account serves nothing until it signs in again, which is done from a
        terminal on the box: <span className={MONO}>sudo proton-bridge-cli</span>, then{' '}
        <span className={MONO}>login</span>. Bridge resumes an unfinished sync when it starts, so an
        account with no sync since then is up to date. Storage is the account&rsquo;s quota at
        Proton; a full one refuses new mail.
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
 * The sync, three ways: moving (the bar, its percentage and Bridge's own
 * estimate), finished since Bridge started, or nothing to do. Only a
 * connected account syncs, so the other two states read as a dash.
 */
function SyncMeter({ u }: { u: BridgeAccount }) {
  const { sync } = u
  if (sync.state === 'syncing') {
    const left = sync.remainingMs > 0 ? ` · ${until(sync.remainingMs / 1000)} left` : ''
    return (
      <Meter
        label="Syncing"
        value={`${pct(sync.progress * 100)}${left}`}
        pct={sync.progress * 100}
        active
      />
    )
  }
  if (u.state !== 'connected') return <Meter label="Sync" value={DASH} pct={null} />
  return (
    <Meter
      label="Sync"
      value={
        sync.finishedAt === null ? (
          'up to date'
        ) : (
          <>
            finished <Ago at={sync.finishedAt} />
          </>
        )
      }
      pct={100}
    />
  )
}

/** A labelled reading over its bar. The bar is always drawn, so two meters side by side share a baseline. */
function Meter({
  label,
  value,
  pct: p,
  tone = 'muted',
  active = false,
}: {
  label: string
  value: ReactNode
  pct: number | null
  tone?: Tone
  active?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 text-[0.78rem]">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums text-foreground [overflow-wrap:anywhere]">{value}</span>
      </div>
      <Progress pct={p} tone={tone} active={active} />
    </div>
  )
}
