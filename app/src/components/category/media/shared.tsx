import { cn } from '../../../lib/cn'
import { DASH } from '../../../lib/format'
import { Segmented } from '../../controls'
import type { LogNeighbour } from '../../logs'
import type { Tone } from '../../viz'

/* ── shared ───────────────────────────────────────────────────────────── */

/* The class strings more than one Media tab writes. Named once for the same
   reason the CSS they replace was: two tabs rendering the same object must not
   drift into two slightly different rows. */

/** A bare vertical list — no marker, no padding, no default margins. */
export const LIST = 'm-0 flex list-none flex-col p-0'

/** A board's caption. */
export const FOOT =
  'm-0 mt-[0.15rem] text-[0.73rem] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]'

/** The reading in a board's header. */
export const NOTE = 'text-[0.73rem] text-muted-foreground'

/** "There is nothing here", said out loud. */
export const EMPTY =
  'm-0 py-[0.9rem] text-center text-[0.8rem] text-muted-foreground [overflow-wrap:anywhere]'

/** An identifier: no spaces to break at, so it is allowed to break anywhere. */
export const MONO = 'font-mono text-[0.86em] [overflow-wrap:anywhere]'

/* A download in flight, shared by qBittorrent, NZBGet, Shelfmark and the *arr
   queues — the same object every time: a name, a line of figures, a bar. */
export const TRANSFERS = `${LIST} gap-[0.6rem]`
export const TRANSFER_ROW = 'flex flex-col gap-[0.25rem]'
export const TRANSFER_HEAD = 'flex min-w-0 items-baseline justify-between gap-[0.8rem]'
export const TRANSFER_NAME = 'min-w-0 truncate text-[0.82rem]'
export const TRANSFER_META =
  'flex items-center gap-[0.3rem] whitespace-nowrap text-[0.72rem] text-muted-foreground tabular-nums'

/* An activity feed. Event, then subject, then when — the event is a fixed
   column because the vocabulary is small and repeated, so a reader scanning for
   one of them is scanning a single column. Below 34rem the three stack. */
export const FEED = `${LIST} gap-[0.12rem] text-[0.8rem]`
export const FEED_ROW =
  'grid grid-cols-[8rem_minmax(0,1fr)_5.5rem] items-baseline gap-[0.7rem] py-[0.16rem] max-[34rem]:grid-cols-[minmax(0,1fr)] max-[34rem]:gap-[0.15rem]'
export const FEED_EVENT = 'text-[0.72rem] uppercase tracking-[0.04em] text-muted-foreground'
export const FEED_TITLE = 'truncate'
export const FEED_WHEN = 'text-right text-[0.75rem] text-muted-foreground max-[34rem]:text-left'

/* A wrapping row of two-word verdicts rather than a list: there are a handful,
   and the only thing being compared is whether any of them is not "Good". */
export const PROVS = 'm-0 flex list-none flex-wrap gap-x-[0.9rem] gap-y-[0.5rem] p-0'
export const PROV = 'flex items-center gap-[0.4rem] text-[0.8rem]'

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
    <div className="mt-[1.75rem] mb-[1.5rem] flex flex-wrap items-center gap-4 border-b border-border pb-[0.9rem] [&>*:last-child]:ml-auto">
      <Segmented value={value} onChange={onChange} options={options} label="Service" />
    </div>
  )
}

/** Whole days as a phrase. Computed on the server — see `daysSince`. */
export function ago(days: number | null): string {
  if (days === null) return DASH
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${String(days)}d ago`
  if (days < 365) return `${String(Math.round(days / 30))}mo ago`
  return `${String(Math.round(days / 365))}y ago`
}

/** The same, forwards. */
export function inDays(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${String(days)}d`
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
    <ul className={`${LIST} gap-[0.3rem]`}>
      {checks.map((c) => (
        <li key={`${c.source}-${c.message}`} className={cn(CHECK_ROW, CHECK_TINT[c.level])}>
          <span className="text-[0.72rem] uppercase tracking-[0.04em] text-muted-foreground">
            {c.source}
          </span>
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
  'grid grid-cols-[9rem_minmax(0,1fr)] items-baseline gap-[0.7rem] rounded-[7px] bg-(--panel-2) px-[0.55rem] py-[0.4rem] text-[0.8rem] max-[34rem]:grid-cols-[minmax(0,1fr)] max-[34rem]:gap-[0.15rem]'

/* Two levels, two literal strings — the fill is a different share of the panel
   for each, so this is a table of two rather than a tone. */
const CHECK_TINT: Record<'warn' | 'bad', string> = {
  warn: 'bg-[color-mix(in_srgb,var(--warning)_10%,var(--panel-2))]',
  bad: 'bg-[color-mix(in_srgb,var(--danger)_12%,var(--panel-2))]',
}

/**
 * The oneshot behind every "from the image's own label" version on this page.
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
