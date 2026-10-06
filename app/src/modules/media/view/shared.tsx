import { Segmented } from '../../../components/controls'
import type { LogNeighbour } from '../../../components/logs'
import { EMPTY } from '../../../components/tokens'
import type { Tone } from '../../../components/viz'
import { cn } from '../../../lib/cn'

/* ── shared ───────────────────────────────────────────────────────────── */

/* The class strings more than one Media tab writes, named once so two tabs
   rendering the same object cannot drift into two slightly different rows.

   The board vocabulary every category page uses lives in components/tokens.ts;
   it is re-exported here so a tab imports only its own page's shared file. */
export { CAPTION, EMPTY, FOOT, MONO, NOTE, SUB } from '../../../components/tokens'

/** A bare vertical list — no marker, no padding, no default margins. */
export const LIST = 'm-0 flex list-none flex-col p-0'

/* A download in flight, shared by qBittorrent, NZBGet and Shelfmark — the same
   object every time: a name, a line of figures, a bar. */
export const TRANSFERS = `${LIST} gap-3`
export const TRANSFER_ROW = 'flex flex-col gap-1'
export const TRANSFER_HEAD = 'flex min-w-0 items-baseline justify-between gap-3'
export const TRANSFER_NAME = 'min-w-0 truncate text-[0.8rem]'
export const TRANSFER_META =
  'flex items-center gap-1.5 whitespace-nowrap text-[0.75rem] text-muted-foreground tabular-nums'

/* An activity feed. Event, then subject, then when — the event is a fixed
   column because the vocabulary is small and repeated, so a reader scanning for
   one of them is scanning a single column. Below 34rem the three stack. */
export const FEED = `${LIST} text-[0.8rem]`
export const FEED_ROW =
  'grid grid-cols-[8rem_minmax(0,1fr)_5.5rem] items-baseline gap-3 border-hairline border-t py-2 first:border-t-0 max-[34rem]:grid-cols-[minmax(0,1fr)] max-[34rem]:gap-0.5'
export const FEED_EVENT = 'text-[0.75rem] text-muted-foreground first-letter:uppercase'
export const FEED_TITLE = 'truncate'
export const FEED_WHEN = 'text-right text-[0.75rem] text-muted-foreground max-[34rem]:text-left'

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
