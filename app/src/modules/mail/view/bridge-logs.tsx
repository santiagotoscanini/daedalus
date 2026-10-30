import { useState } from 'react'
import { Ago } from '../../../components/ago'
import { QuietState, SECTION_SPAN, TABLE_NONE } from '../../../components/modules/parts'
import {
  CELL_QUIET,
  TABLE,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
  TableMore,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { FOOT, MONO } from '../../../components/tokens'
import { Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { BridgeLogGroup, BridgeLogs } from '../data/bridge-logs'

// Email › what Bridge itself logged as a warning or worse over the last day,
// one row per message with how often and how lately.

/** Rows before the rest fold. */
const SHOWN = 8

/** Level · message · count · last. The count steps away first. */
const GRID =
  'grid items-start gap-x-5 px-5 grid-cols-[6.5rem_minmax(0,1fr)_3.5rem_5.5rem] @max-[40rem]/table:grid-cols-[minmax(0,1fr)_5rem] @max-[40rem]/table:gap-x-3 @max-[40rem]/table:[&>.wide]:hidden'

export function BridgeLogsTable({ logs }: { logs: BridgeLogs }) {
  const [all, setAll] = useState(false)
  const shown = all ? logs.groups : logs.groups.slice(0, SHOWN)
  const at = logs.capped ? 'at least ' : ''

  return (
    <TableSection
      title="Warnings and errors"
      aside={`last ${String(logs.windowHours)} hours`}
      note={`${at}${num(logs.warnings)} warning${logs.warnings === 1 ? '' : 's'} · ${num(logs.errors)} error${logs.errors === 1 ? '' : 's'}${logs.routine > 0 ? ` · ${num(logs.routine)} routine` : ''}`}
      className={SECTION_SPAN[12]}
    >
      {logs.groups.length === 0 ? (
        <p className={TABLE_NONE}>Nothing at warning or above in the last day.</p>
      ) : (
        <ul className={TABLE} aria-label="Bridge warnings and errors">
          <li className={cn(GRID, TABLE_HEAD)}>
            <span className="wide">Level</span>
            <span>Message</span>
            <span className="wide text-right">Lines</span>
            <span className="text-right">Last</span>
          </li>
          {shown.map((g) => (
            <Row key={`${g.level} ${g.message}`} g={g} />
          ))}
          {logs.groups.length > SHOWN && (
            <TableMore
              open={all}
              onToggle={() => {
                setAll((v) => !v)
              }}
              more={`${num(logs.groups.length - SHOWN)} more`}
              less={`Show the latest ${String(SHOWN)}`}
            />
          )}
        </ul>
      )}
      <p className={FOOT}>
        Bridge&rsquo;s own log, grouped by message. A <b>routine</b> row is the expired-token 401
        Proton&rsquo;s client logs (a warning, then an error) just before it refreshes the session
        and retries, about every half hour. A failed refresh is not routine: the session was
        revoked, and the account signs in again with{' '}
        <span className={MONO}>sudo proton-bridge-cli</span>.
      </p>
    </TableSection>
  )
}

function Level({ g }: { g: BridgeLogGroup }) {
  if (g.verdict === 'routine') return <QuietState>routine</QuietState>
  if (g.verdict === 'sign-in') return <Chip tone="bad">sign in again</Chip>
  return g.level === 'error' ? <Chip tone="warn">error</Chip> : <QuietState>warning</QuietState>
}

function Row({ g }: { g: BridgeLogGroup }) {
  const quiet = g.verdict === 'routine'
  return (
    <li className={cn(GRID, TABLE_ROW_DENSE)}>
      <span className="wide py-1">
        <Level g={g} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5 py-1">
        <span
          className={cn(
            'text-[0.8125rem] [overflow-wrap:break-word]',
            quiet ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {g.message}
          <span className="hidden @max-[40rem]/table:inline">
            {' '}
            <Level g={g} />
          </span>
        </span>
        {g.detail !== null && (
          <span className="font-mono text-[0.72rem] text-muted-foreground [overflow-wrap:break-word]">
            {g.detail}
          </span>
        )}
      </span>
      <span className={cn(CELL_QUIET, 'wide py-1 text-right')}>{num(g.count)}</span>
      <span className={cn(CELL_QUIET, 'py-1 text-right')}>
        <Ago at={g.lastAt} />
      </span>
    </li>
  )
}
