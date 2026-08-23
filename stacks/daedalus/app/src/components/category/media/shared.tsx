import { DASH } from '../../../lib/format'
import type { LogNeighbour } from '../../logs'
import { Segmented } from '../../ui'
import type { Tone } from '../../viz'

/* ── shared ───────────────────────────────────────────────────────────── */

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
    <div className="tunnel-bar">
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
  if (!reachable) return <p className="viz-empty">could not ask</p>
  if (checks.length === 0)
    return <p className="viz-empty">No warnings. Every check this service runs is passing.</p>

  return (
    <ul className="hchecks">
      {checks.map((c) => (
        <li key={`${c.source}-${c.message}`} className={`hcheck hcheck-${c.level}`}>
          <span className="hcheck-src">{c.source}</span>
          <span className="hcheck-msg">
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
