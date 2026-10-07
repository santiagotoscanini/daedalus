import type { ReactNode } from 'react'
import { Segmented } from '../../../components/controls'
import { ExplainToggle, useExplain } from '../../../components/explain'
import type { LogNeighbour } from '../../../components/logs'
import {
  CELL_QUIET,
  SECTION_NOTE,
  SECTION_TITLE,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
} from '../../../components/table'
import { EMPTY } from '../../../components/tokens'
import { Progress, type Tone } from '../../../components/viz'
import { cn } from '../../../lib/cn'

/* ── shared ───────────────────────────────────────────────────────────── */

export {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  CELL_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableGroup,
} from '../../../components/table'
/* The class strings more than one Media tab writes, named once so two tabs
   rendering the same object cannot drift into two slightly different rows.

   The board vocabulary every category page uses lives in components/tokens.ts;
   it is re-exported here so a tab imports only its own page's shared file. */
export { CAPTION, EMPTY, FOOT, MONO, NOTE, SUB } from '../../../components/tokens'

/** A bare vertical list — no marker, no padding, no default margins. */
export const LIST = 'm-0 flex list-none flex-col p-0'

/* A wrapping row of two-word verdicts rather than a list: there are a handful,
   and the only thing being compared is whether any of them is not "Good". */
export const PROVS = 'm-0 flex list-none flex-wrap gap-x-4 gap-y-2 p-0'
export const PROV = 'flex items-center gap-1.5 text-[0.8rem]'

/**
 * A tri-state health as a dot tone.
 *
 * `null` is "could not be read", which is grey — deliberately not the same
 * claim as down, and the state a service lands in when the thing that would
 * answer for it is itself unreachable.
 */
export function tone(ok: boolean | null): Tone | null {
  return ok === null ? null : ok ? 'ok' : 'bad'
}

/** The switch above a tab that holds more than one service. */
export function ServiceBar<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; dot?: Tone | null }[]
}) {
  return (
    // The switch is always on the right, whether or not anything sits to its
    // left — `ml-auto` on the last child does both cases, where `justify-between`
    // would park a lone child at the start.
    <div className="mt-6 mb-5 flex flex-wrap items-center gap-4 [&>*:last-child]:ml-auto">
      <Segmented value={value} onChange={onChange} options={options} label="Service" />
    </div>
  )
}

/**
 * A service's own health checks.
 *
 * The single most useful thing on the *arr pages and the one thing nothing else
 * on this box reports: an indexer that has been failing for a week, a root
 * folder that has gone missing, a download client that stopped answering. Every
 * one of those is invisible in the counts — the queue is empty and the library
 * is intact, because nothing is being attempted.
 *
 * Silence is a real answer here and gets said out loud, because an empty panel
 * and a panel that could not be read look identical otherwise.
 */
export function HealthChecks({
  checks,
  reachable,
}: {
  checks: { level: 'warn' | 'bad'; source: string; message: string; url: string | null }[]
  reachable: boolean
}) {
  if (!reachable) return <p className={EMPTY}>could not ask</p>
  if (checks.length === 0)
    return <p className={EMPTY}>No warnings. Every check this service runs is passing.</p>

  return (
    <ul className={`${LIST} gap-1.5`}>
      {checks.map((c) => (
        <li key={`${c.source}-${c.message}`} className={cn(CHECK_ROW, CHECK_TINT[c.level])}>
          <span className="text-[0.75rem] text-muted-foreground">{c.source}</span>
          <span className="min-w-0 text-foreground [&_a]:whitespace-nowrap [&_a]:text-muted-foreground">
            {c.message}
            {c.url !== null && (
              <a href={c.url} target="_blank" rel="noreferrer">
                {' '}
                wiki ↗
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/* Two columns rather than a paragraph per row: the source is the part you scan
   for (which subsystem), the message is the part you read once you have found
   it. Below 34rem the two stack. */
export const CHECK_ROW =
  'grid grid-cols-[9rem_minmax(0,1fr)] items-baseline gap-3 rounded-xl border border-hairline bg-foreground/[0.03] px-3 py-2 text-[0.8rem] max-[34rem]:grid-cols-[minmax(0,1fr)] max-[34rem]:gap-0.5'

/* Two levels, two literal strings — the fill is a different share of the panel
   for each, so this is a table of two rather than a tone. */
const CHECK_TINT: Record<'warn' | 'bad', string> = {
  warn: 'border-warning/25 bg-warning/[0.07]',
  bad: 'border-danger/25 bg-danger/[0.08]',
}

/**
 * The oneshot behind every "from the image's own label" version in this module.
 *
 * A neighbour of Shelfmark, Janitorr and Recyclarr specifically — the three
 * whose pin is a channel, so the snapshot is the ONLY thing that knows what
 * they are running. When one of them starts reporting "unknown", this is the
 * log that says why, and it is the reason a systemd unit can be a neighbour at
 * all (see `LogNeighbour`).
 */
export const VERSION_SNAPSHOT: LogNeighbour = {
  source: { unit: 'daedalus-image-snapshot.service' },
  label: 'Version snapshot',
  role: 'where this version comes from',
  note: 'Reads the OCI labels off every running image and publishes them for this dashboard, since the pin on these three names a channel rather than a release. One line per run with the counts; if the version above says “unknown”, this says whether the snapshot ran at all. Its failures also send mail — see fleet.monitoredJobs in stacks/daedalus.',
}

/**
 * The quiet half of a service's health checks: one line under its head when
 * every check passes, nothing louder. Healthy is the norm and gets no board;
 * a failing check is the exception and gets `HealthChecks` in a board of its
 * own. Unreachable is neither, and says so.
 */
export function HealthLine({
  checks,
  reachable,
}: {
  checks: readonly unknown[]
  reachable: boolean
}) {
  if (reachable && checks.length > 0) return null
  return (
    <p className={HEALTH_LINE}>
      {reachable
        ? 'Health checks: no warnings. Every check this service runs is passing.'
        : 'Health checks: could not ask.'}
    </p>
  )
}

/** Whether a service's checks deserve a board: only when one is failing. */
export const healthFailing = (checks: readonly unknown[], reachable: boolean) =>
  reachable && checks.length > 0

/* Hangs under the head's link row, indented to its text column like the links. */
const HEALTH_LINE = '-mt-3 mb-6 ml-15 text-[0.75rem] text-muted-foreground max-[44rem]:ml-0'

/* ── a table with a heading ───────────────────────────────────────────────
   The section a list of things is drawn in: SECTION_TITLE over a TABLE, on the
   board grid beside the boards. Its explanation folds behind an ⓘ in the
   title, the way a Board's does. */

export function TableSection({
  title,
  note,
  aside,
  foot,
  children,
}: {
  title: string
  /** A visible line under the title: counts, a state. */
  note?: ReactNode
  /** Right of the title: a live reading. */
  aside?: ReactNode
  /** Under the table: FOOT folds behind the ⓘ, CAPTION stays. */
  foot?: ReactNode
  children: ReactNode
}) {
  const explain = useExplain()
  return (
    <section className={cn(TABLE_SECTION, explain.body)}>
      <h3 className={cn(SECTION_TITLE, 'mt-0 min-h-6')}>
        {title}
        <ExplainToggle
          open={explain.open}
          onToggle={explain.toggle}
          className="-my-1 hidden group-has-[.explain]/section:inline-flex"
        />
        {aside !== undefined && (
          <span className="ml-auto text-[0.78rem] font-normal text-muted-foreground">{aside}</span>
        )}
      </h3>
      {note !== undefined && <p className={SECTION_NOTE}>{note}</p>}
      {children}
      {foot !== undefined && <div className="mt-3 flex flex-col gap-2">{foot}</div>}
    </section>
  )
}

/** Full width on the board grid, with a section's air above and below. */
const TABLE_SECTION = 'group/section col-span-12 my-6 min-w-0 first:mt-0 last:mb-0'

/* ── a queue ──────────────────────────────────────────────────────────────
   Something on its way — a torrent, an NZB, a book, an import — is the same
   object on every downloader: a name, how far, and the figures that say how
   it is going. One table for all of them, so four downloaders read alike. */

const QUEUE_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_3.5rem_minmax(0,1.4fr)]',
  '@max-[44rem]/table:grid-cols-[minmax(0,1fr)_3.5rem]',
)
const QUEUE_WIDE = '@max-[44rem]/table:hidden'

export type QueueRow = {
  key: string
  name: string
  pct: number | null
  tone: Tone
  active: boolean
  /** The figures on the right: a rate, a size, a time left, a state. */
  detail: ReactNode
}

export function QueueTable({
  rows,
  empty,
  label,
  detail = 'Progress',
}: {
  rows: QueueRow[]
  /** What an empty queue means, said in the one row. */
  empty: string
  label: string
  /** The right-hand column's label. */
  detail?: string
}) {
  return (
    <ul className={TABLE} aria-label={label}>
      {/* No column labels over an empty queue: one quiet row is the answer. */}
      {rows.length > 0 && (
        <li aria-hidden="true" className={cn(QUEUE_GRID, TABLE_HEAD)}>
          <span>Name</span>
          <span className={QUEUE_WIDE} />
          <span className="text-right">Done</span>
          <span className={cn(QUEUE_WIDE, 'text-right')}>{detail}</span>
        </li>
      )}
      {rows.length === 0 ? (
        <li className={cn(TABLE_EMPTY, 'py-6')}>{empty}</li>
      ) : (
        rows.map((r) => (
          <li key={r.key} className={cn(QUEUE_GRID, TABLE_ROW)}>
            <span className="truncate text-foreground" title={r.name}>
              {r.name}
            </span>
            <span className={QUEUE_WIDE}>
              <Progress pct={r.pct} tone={r.tone} active={r.active} />
            </span>
            <span className={cn(CELL_QUIET, 'text-right text-foreground')}>
              {r.pct === null ? '' : `${r.pct.toFixed(0)}%`}
            </span>
            <span
              className={cn(
                CELL_QUIET,
                QUEUE_WIDE,
                'flex min-w-0 items-center justify-end gap-1.5 truncate',
              )}
            >
              {r.detail}
            </span>
          </li>
        ))
      )}
    </ul>
  )
}
