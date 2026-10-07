import { Link } from '@tanstack/react-router'
import { ChevronRightIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../../../lib/cn'
import type { Machine } from '../../../lib/dashboard/machines'
import { bytes, duration } from '../../../lib/format'
import { Ago } from '../../ago'
import {
  CELL_MONO,
  CELL_NAME,
  CELL_SUB,
  TABLE_HEAD,
  TABLE_LINK,
  TABLE_ROW,
  TABLE_ROW_LINK,
} from '../../table'
import { Chip } from '../../viz'
import { ASIDE, Band, ERROR_NOTE, Mono, NOTE_SHOWN } from '../shared'
import { Decision } from './decision'
import { ClaudeCell, OsMark, osName, StatusCell, TrustNote, TunnelCell } from './machine-cells'
import { Policy } from './policy'

// One machine, as a row of the Machines table — what it is, how it stands,
// where it is, which agent — that opens in place into the whole story: the
// facts its agent reports, the box's decision about it, and once approved
// the policy the box sends it. One machine is open at a time and the open
// one is in the URL (`?node=`), so a refresh or a link lands on it; a key
// waiting to join is always open, since it is waiting on you.

/** Machine, status, address, agent, the chevron — one grid for the head and every row. */
export const MACHINE_GRID =
  'grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_8.5rem_5.5rem_1rem] items-center gap-x-6 px-5 @max-[46rem]/table:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_1rem] @max-[38rem]/table:grid-cols-[minmax(0,1fr)_1rem] @max-[38rem]/table:gap-x-3'
/** The columns that step away on a narrow table. */
const STEP = '@max-[46rem]/table:hidden'
/** The status column, which on a phone moves under the name. */
const PHONE_HIDE = '@max-[38rem]/table:hidden'

export function MachinesHead() {
  return (
    <li className={cn(MACHINE_GRID, TABLE_HEAD)}>
      <span>Machine</span>
      <span className={PHONE_HIDE}>Status</span>
      <span className={STEP}>Address</span>
      <span className={STEP}>Agent</span>
      <span />
    </li>
  )
}

/**
 * A fact and its width: one column, two, or the whole line (a key, a tunnel).
 * `narrow` is a fact the row already shows in its columns — drawn here only
 * once the table is too narrow to show those columns, so it is said once.
 */
/** An open machine: a faint well, so its story reads as inside the row and the next row as the next machine. */
const OPEN = 'bg-foreground/[0.018]'

type Fact = { k: string; v: ReactNode; wide?: boolean; half?: boolean; narrow?: boolean }

/** A machine's facts, label over value, as many to a line as the width takes. */
function Facts({ facts }: { facts: Fact[] }) {
  return (
    <dl className="m-0 grid grid-cols-4 gap-x-8 @max-[46rem]/table:grid-cols-2 @max-[30rem]/table:grid-cols-1 gap-y-4 border-hairline border-t px-5 py-5">
      {facts.map((f) => (
        <div
          key={f.k}
          className={cn(
            'flex min-w-0 flex-col gap-1',
            f.wide === true && 'col-span-full',
            f.half === true && 'col-span-2 @max-[30rem]/table:col-span-1',
            f.narrow === true && 'hidden @max-[46rem]/table:flex',
          )}
        >
          <dt className="text-[0.75rem] text-muted-foreground">{f.k}</dt>
          <dd className="m-0 min-w-0 text-[0.8125rem]">{f.v}</dd>
        </div>
      ))}
    </dl>
  )
}

/** The summary line of a row: a link that opens or closes it, stretched over the line. */
function Summary({
  id,
  open,
  toggles,
  name,
  sub,
  os,
  status,
  address,
  agent,
}: {
  id: string
  open: boolean
  /** False for a row that is always open. */
  toggles: boolean
  name: string
  sub: ReactNode
  os: string
  status: ReactNode
  address: string | null
  agent: string | null
}) {
  const title = (
    <span className="flex min-w-0 items-center gap-2.5">
      <OsMark os={os} />
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            CELL_NAME,
            '@max-[38rem]/table:whitespace-normal @max-[38rem]/table:[overflow-wrap:anywhere]',
          )}
        >
          {name}
        </span>
        <span className={cn(CELL_SUB, '@max-[38rem]/table:whitespace-normal')}>{sub}</span>
        {/* On a phone the status joins the name instead of taking a column. */}
        <span className="mt-0.5 hidden @max-[38rem]/table:block">{status}</span>
      </span>
    </span>
  )
  return (
    <div
      className={cn(
        MACHINE_GRID,
        'relative min-h-[3.75rem] py-2.5 text-[0.8125rem]',
        toggles && TABLE_ROW_LINK,
      )}
    >
      {toggles ? (
        <Link
          to="/settings"
          search={open ? { tab: 'machines' } : { tab: 'machines', node: id }}
          replace
          resetScroll={false}
          aria-expanded={open}
          className={cn(TABLE_LINK, 'min-w-0')}
        >
          {title}
        </Link>
      ) : (
        title
      )}
      <span className={cn('min-w-0', PHONE_HIDE)}>{status}</span>
      <span className={cn(CELL_MONO, STEP)}>{address ?? '—'}</span>
      <span className={cn(CELL_MONO, STEP)}>{agent ?? '—'}</span>
      <span className="flex justify-end text-muted-foreground">
        {toggles && (
          <ChevronRightIcon
            aria-hidden="true"
            className={cn('size-4 transition-transform duration-150', open && 'rotate-90')}
          />
        )}
      </span>
    </div>
  )
}

/** One decided machine: the row, and — open — its facts, the decision and the policy. */
export function MachineRow({
  m,
  lanDomain,
  open,
  askSantree,
}: {
  m: Machine
  lanDomain: string
  open: boolean
  /** The page was opened to turn santree on for this machine. */
  askSantree: boolean
}) {
  const n = m.node
  if (n === null) return null
  const s = m.status
  const edition = s?.os_name || osName(n.os)
  const version = s?.os_version ?? ''
  const arch = s?.arch || n.arch
  const agent = s?.version ?? n.agentVersion

  const facts: Fact[] = [
    ...(s?.cpu ? [{ k: 'Processor', v: <span>{s.cpu}</span> }] : []),
    ...(s?.memory_bytes != null
      ? [{ k: 'Memory', v: <span className="tabular-nums">{bytes(s.memory_bytes)}</span> }]
      : []),
    {
      k: 'Machine up',
      v: (
        <span className="tabular-nums">
          {s?.os_uptime_secs == null ? '—' : duration(s.os_uptime_secs)}
        </span>
      ),
    },
    ...(n.mac !== null ? [{ k: 'Hardware address', v: <Mono>{n.mac}</Mono> }] : []),
    { k: 'Agent', v: <Mono>{agent}</Mono>, narrow: true },
    {
      k: 'Updates',
      v:
        s === null ? (
          <span className={ASIDE}>—</span>
        ) : s.restart_pending ? (
          <Chip tone="warn">installed, restarting</Chip>
        ) : s.update_available !== null ? (
          <Chip tone="warn">{s.update_available} available</Chip>
        ) : (
          <span className={ASIDE}>
            {s.last_update_result ?? 'not checked yet'}
            {s.last_update_check !== null && (
              <>
                {' · '}
                <Ago at={s.last_update_check} />
              </>
            )}
          </span>
        ),
      half: true,
    },
    {
      k: 'Address',
      v: n.lanIp === null ? <span className={ASIDE}>—</span> : <Mono>{n.lanIp}</Mono>,
      narrow: true,
    },
    { k: 'Claude', v: <ClaudeCell m={m} />, half: true },
    ...(s?.controller?.tunnel != null
      ? [{ k: 'Tunnel', v: <TunnelCell t={s.controller.tunnel} />, wide: true }]
      : []),
    ...(s?.controller != null
      ? [{ k: 'Its key', v: <Mono>{s.controller.fingerprint}</Mono>, wide: true }]
      : []),
    ...(s?.controller?.rotated != null
      ? [
          {
            k: 'Controller key',
            v: <span className={ASIDE}>{s.controller.rotated}</span>,
            wide: true,
          },
        ]
      : []),
  ]

  return (
    <li className={cn(TABLE_ROW, 'block min-h-0 py-0', open && OPEN)}>
      <Summary
        id={n.id}
        open={open}
        toggles
        name={n.name}
        sub={
          <>
            {edition}
            {version !== '' && ` · ${version}`}
            {arch !== '' && ` · ${arch}`}
          </>
        }
        os={n.os}
        status={<StatusCell m={m} />}
        address={n.lanIp}
        agent={agent}
      />
      {open && (
        <div className="cursor-auto">
          <Facts facts={facts} />
          <Band>
            {s?.hold_error != null && <p className={ERROR_NOTE}>The hold failed: {s.hold_error}</p>}
            <TrustNote link={s?.controller ?? null} />
            <Decision m={m} />
          </Band>
          {n.state === 'approved' && (
            <Policy
              n={n}
              shape={m.shape}
              lanDomain={lanDomain}
              os={edition}
              agentVersion={agent}
              askSantree={askSantree}
            />
          )}
        </div>
      )}
    </li>
  )
}

/** A key waiting at the controller: what it says it is, and the two fingerprints to compare. */
export function PendingRow({
  m,
  controllerFingerprint,
}: {
  m: Machine
  controllerFingerprint: string | null
}) {
  const p = m.pending
  if (p === null) return null
  return (
    <li className={cn(TABLE_ROW, 'block min-h-0 py-0', OPEN)}>
      <Summary
        id={p.id}
        open
        toggles={false}
        name={p.hostname ?? p.id}
        sub={
          <>
            {osName(p.os)}
            {p.arch !== null && ` · ${p.arch}`}
          </>
        }
        os={p.os ?? ''}
        status={<Chip tone="warn">wants to join</Chip>}
        address={p.lan_ip}
        agent={p.agent_version}
      />
      <Facts
        facts={[
          { k: 'Its key', v: <Mono>{p.fingerprint}</Mono>, wide: true },
          {
            k: 'Controller key',
            v:
              controllerFingerprint === null ? (
                <span className={ASIDE}>the controller did not say</span>
              ) : (
                <Mono>{controllerFingerprint}</Mono>
              ),
            wide: true,
          },
          {
            k: 'Address',
            v: p.lan_ip === null ? <span className={ASIDE}>—</span> : <Mono>{p.lan_ip}</Mono>,
            narrow: true,
          },
          ...(p.agent_version !== null
            ? [{ k: 'Agent', v: <Mono>{p.agent_version}</Mono>, narrow: true }]
            : []),
        ]}
      />
      <Band>
        <p className={NOTE_SHOWN}>
          The machine's tray and status page show both keys. Approve only if they match what it
          shows: its own, and the controller's it trusts.
        </p>
        <Decision m={m} />
      </Band>
    </li>
  )
}
