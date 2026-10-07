// Gateway › Who is calling: one row per key, read down its columns.

import { Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { compact, DASH, daysAgo, ms, num } from '../../../lib/format'
import type { LitellmData } from '../data/litellm'
import type { LitellmFacts } from './litellm'
import {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  FOOT,
  REJECTED,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableSection,
} from './shared'

/* Caller, then requests (the ranking, with its bar), then what each request
   cost; the models a key reached and when it last called step away first. */
const CALLER_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_4rem_4.5rem_4rem_minmax(0,1.4fr)_5.5rem]',
  '@max-[60rem]/table:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_4rem_4rem_5.5rem]',
  '@max-[38rem]/table:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]',
)
const WIDE = '@max-[60rem]/table:hidden'
const MID = '@max-[38rem]/table:hidden'
const NUM = cn(CELL_QUIET, 'text-right')

/** The bar is the comparison this table exists to make, so it is the one drawn thing in a row. */
const BAR = 'block h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]'
const BAR_FILL =
  'block h-full origin-left animate-[bar-grow_600ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-full bg-info opacity-85 motion-reduce:animate-none'

export function WhoIsCallingBoard({ f }: { f: LitellmFacts }) {
  const { data, total, todayDate } = f
  const max = Math.max(data.callers[0]?.requests ?? 1, 1)
  return (
    <TableSection
      title="Who is calling"
      note={`Requests over ${String(total.days)} days, by the key that made them`}
      foot={
        <>
          {/* Rejected keys are split out rather than ranked — see `callersOf`:
              a rejected key returns no tokens at all, so on a token ranking it
              would score zero and never appear. */}
          {data.rejected.keys > 0 && (
            <p className={REJECTED}>
              <b>{num(data.rejected.keys)}</b> keys never completed a request.{' '}
              <b>{num(data.rejected.requests)}</b> attempts, last{' '}
              {ledgerAgo(data.rejected.last, todayDate)}.{' '}
              {data.rejected.live === 0 ? (
                'None of them exists on the gateway today.'
              ) : (
                <>
                  <b>{num(data.rejected.live)}</b> of them still exists on the gateway, which is a
                  fault rather than a stale credential.
                </>
              )}
            </p>
          )}
          <p className={FOOT}>
            Named by their key’s alias; a key with none shows as its hash, and one the gateway no
            longer holds is marked <b>revoked</b>. Hover any name for what it is. A key that fails
            authentication never reaches a model, so it has no tokens and no model against it. The
            gateway is LAN-only, so every attempt above came from something in the house.
          </p>
        </>
      }
    >
      <ul className={TABLE} aria-label="Who is calling the gateway">
        <li aria-hidden="true" className={cn(CALLER_GRID, TABLE_HEAD)}>
          <span>Caller</span>
          <span className="text-right">Requests</span>
          <span className={cn(MID, 'text-right')}>Tokens</span>
          <span className={cn(WIDE, 'text-right')}>Latency</span>
          <span className={cn(MID, 'text-right')}>Failed</span>
          <span className={WIDE}>Models</span>
          <span className={cn(MID, 'text-right')}>Last call</span>
        </li>
        {data.callers.length === 0 ? (
          <li className={TABLE_EMPTY}>No keyed traffic in the window.</li>
        ) : (
          data.callers.map((c) => <CallerRow key={c.name} caller={c} max={max} today={todayDate} />)
        )}
      </ul>
    </TableSection>
  )
}

type Caller = LitellmData['callers'][number]

/**
 * One caller.
 *
 * Failures get the only colour in the row, and only when there are any. A
 * caller that works is the normal case and does not need to be decorated to
 * say so.
 */
function CallerRow({ caller, max, today }: { caller: Caller; max: number; today: string }) {
  return (
    <li className={cn(CALLER_GRID, TABLE_ROW)}>
      <span className="flex min-w-0 items-center gap-2">
        <span
          // A name that cannot be read at face value — an internal credential,
          // or a hash — carries its explanation on a hover, and says so with a
          // dotted underline.
          className={cn(CELL_NAME, caller.note !== null && 'cursor-help border-b border-dotted')}
          title={caller.note ?? caller.name}
        >
          {caller.name}
        </span>
        {!caller.live && <Chip tone="warn">revoked</Chip>}
      </span>
      <span className="flex min-w-0 items-center gap-3">
        <span className={BAR}>
          <span
            className={BAR_FILL}
            style={{ width: `${String(Math.max(1.5, (caller.requests / max) * 100))}%` }}
          />
        </span>
        <span className="w-12 flex-none text-right text-[0.8125rem] text-foreground tabular-nums">
          {num(caller.requests)}
        </span>
      </span>
      <span className={cn(NUM, MID)}>{caller.tokens > 0 ? compact(caller.tokens) : ''}</span>
      <span className={cn(NUM, WIDE)}>{caller.latencyMs === null ? '' : ms(caller.latencyMs)}</span>
      <span className={cn(NUM, MID, caller.failed > 0 && 'text-danger')}>
        {caller.failed > 0 ? num(caller.failed) : ''}
      </span>
      {/* One name and a count. A caller reaching a single model is the norm,
          and the master key reaches several — the rest is a hover away. */}
      <span className={cn(CELL_MONO, WIDE)} title={caller.models.join(', ')}>
        {caller.models[0] ?? ''}
        {caller.models.length > 1 && ` +${String(caller.models.length - 1)}`}
      </span>
      <span className={cn(NUM, MID)}>{ledgerAgo(caller.last, today)}</span>
    </li>
  )
}

/**
 * A ledger date as a phrase.
 *
 * Days rather than `since`, because the ledger's resolution IS a day: it knows
 * a key called on the 3rd, not at what time, and "2 days ago" is the strongest
 * true statement available. Computed against a date passed in rather than
 * against `Date.now()` — this page renders on the server and hydrates in the
 * browser, and a relative time derived from two different clocks is a
 * hydration mismatch waiting for midnight.
 */
function ledgerAgo(date: string | null, today: string): string {
  if (date === null || date === '') return DASH
  const days = Math.round((Date.parse(today) - Date.parse(date)) / 86400_000)
  return Number.isFinite(days) ? daysAgo(days) : date
}
