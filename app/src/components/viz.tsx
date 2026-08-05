// Visual primitives for the category pages.
//
// All hand-rolled SVG and CSS, no charting library — same reasoning as the
// existing AreaChart: a chart dependency would be the largest thing in
// node_modules by an order of magnitude, in a container whose entire design is
// to start fast and reload faster (source.mode = "local" runs vite dev in
// production, so every byte here is parsed on a cold page load).
//
// Two rules every component below follows:
//
//   Absent data renders as absent, never as zero. A ring at 0% and a ring
//   with no reading look identical if you draw them the same way, and on a
//   page fed by thirty services the difference is the whole point.
//
//   Motion means something is happening. Nothing here animates on a timer for
//   decoration: a bar shimmers while a download is actually moving, a dot
//   pulses while a stream is actually playing. Idle content sits still, so
//   movement in the corner of your eye is always worth looking at.

import type { ReactNode } from 'react'

export type Tone = 'accent' | 'ok' | 'warn' | 'bad' | 'info' | 'muted'

/* ── headline numbers ─────────────────────────────────────────────────── */

/**
 * One large number with its label — the top band of every category page.
 *
 * `value` is a pre-formatted string, not a number: the loader that read it
 * knows whether it is bytes, Mbps or a count, and re-deriving that here would
 * mean passing the unit along anyway.
 */
export function BigStat({
  label,
  value,
  unit,
  sub,
  tone = 'accent',
  spark,
}: {
  label: string
  value: string
  unit?: string
  sub?: ReactNode
  tone?: Tone
  spark?: number[]
}) {
  return (
    <div className={`bigstat bigstat-${tone}`}>
      <span className="bigstat-label">{label}</span>
      <span className="bigstat-value">
        {value}
        {unit !== undefined && <em>{unit}</em>}
      </span>
      {spark !== undefined && spark.length > 1 && <MicroSpark values={spark} tone={tone} />}
      {sub !== undefined && <span className="bigstat-sub">{sub}</span>}
    </div>
  )
}

export function StatBand({ children }: { children: ReactNode }) {
  return <div className="statband">{children}</div>
}

/* ── ring gauge ───────────────────────────────────────────────────────── */

/**
 * A proportion, as a ring.
 *
 * Chosen over a bar wherever the number is a *share of a whole* that the eye
 * should read without comparing to anything else — block rate, CPU, pool
 * capacity. The ring is drawn as a stroke-dasharray on a circle and grows from
 * empty on mount, so a page load reads as the numbers arriving.
 *
 * `pct === null` draws the track alone with the value slot showing an em dash:
 * an empty ring, not a zero ring.
 */
export function Ring({
  pct,
  value,
  label,
  tone = 'accent',
  size = 108,
}: {
  pct: number | null
  value: string
  label?: string
  tone?: Tone
  size?: number
}) {
  const r = 46
  const circumference = 2 * Math.PI * r
  const clamped = pct === null ? 0 : Math.max(0, Math.min(100, pct))
  const dash = (clamped / 100) * circumference

  return (
    <div className={`ring ring-${tone}`} style={{ width: size }}>
      <svg viewBox="0 0 108 108" aria-hidden="true">
        <circle className="ring-track" cx="54" cy="54" r={r} />
        {pct !== null && (
          <circle
            className="ring-fill"
            cx="54"
            cy="54"
            r={r}
            // Drawn from 12 o'clock: a gauge that starts at 3 o'clock reads as
            // an arbitrary slice rather than as "this much of the whole".
            transform="rotate(-90 54 54)"
            strokeDasharray={`${dash.toFixed(2)} ${circumference.toFixed(2)}`}
            style={{ ['--ring-dash' as string]: `${dash.toFixed(2)}` }}
          />
        )}
      </svg>
      <div className="ring-text">
        <strong>{value}</strong>
        {label !== undefined && <span>{label}</span>}
      </div>
    </div>
  )
}

/* ── bars ─────────────────────────────────────────────────────────────── */

export type BarItem = { label: string; value: number; display?: string; tone?: Tone }

/**
 * A ranked list as proportional bars — "which of these is the big one".
 *
 * Scaled against the largest item rather than a total, because these lists are
 * almost always a top-N of a longer tail: normalising to the visible sum would
 * silently inflate every bar by however much was cut off.
 */
export function BarList({
  items,
  tone = 'accent',
  max,
  empty = 'no data',
}: {
  items: BarItem[]
  tone?: Tone
  /** Override the scale — for bars that must be comparable across panels. */
  max?: number
  empty?: string
}) {
  if (items.length === 0) return <p className="viz-empty">{empty}</p>
  const ceiling = max ?? Math.max(...items.map((i) => i.value), 0.0001)

  return (
    <ul className="barlist">
      {items.map((i) => (
        <li key={i.label} className={`barlist-row barlist-${i.tone ?? tone}`}>
          <span className="barlist-label" title={i.label}>
            {i.label}
          </span>
          <span className="barlist-track">
            <span
              className="barlist-fill"
              style={{ width: `${String(Math.max(1.5, (i.value / ceiling) * 100))}%` }}
            />
          </span>
          <span className="barlist-value">{i.display ?? i.value.toLocaleString('en-US')}</span>
        </li>
      ))}
    </ul>
  )
}

/* ── time series ──────────────────────────────────────────────────────── */

export type Column = { label: string; value: number; display?: string }

/**
 * A time series as columns — for daily buckets, where the gaps between bars
 * carry meaning (one bar = one day) and a continuous line would imply the
 * values in between were measured.
 */
export function Columns({
  points,
  tone = 'accent',
  height = 84,
  empty = 'no data',
}: {
  points: Column[]
  tone?: Tone
  height?: number
  empty?: string
}) {
  if (points.length === 0) return <p className="viz-empty">{empty}</p>
  const max = Math.max(...points.map((p) => p.value), 0.0001)

  return (
    <div className={`columns columns-${tone}`} style={{ height }}>
      {points.map((p, i) => (
        <div
          key={`${p.label}-${String(i)}`}
          className="columns-col"
          title={`${p.label}: ${p.display ?? p.value.toLocaleString('en-US')}`}
        >
          <span
            className="columns-bar"
            style={{
              height: `${String(Math.max(2, (p.value / max) * 100))}%`,
              // Staggered so the band fills left-to-right on load. Capped so a
              // 30-column chart does not take a second and a half to draw.
              animationDelay: `${String(Math.min(i * 18, 500))}ms`,
            }}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * A continuous series as a filled line — for anything sampled on a fixed
 * interval, where the line between two points is a fair claim.
 */
export function Trend({
  values,
  tone = 'accent',
  height = 90,
  empty = 'no data',
}: {
  values: number[]
  tone?: Tone
  height?: number
  empty?: string
}) {
  if (values.length < 2) return <p className="viz-empty">{empty}</p>

  const w = 600
  const max = Math.max(...values, 0.0001)
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => [i * step, height - (v / max) * (height - 6) - 3] as const)
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')

  return (
    <svg
      className={`trend trend-${tone}`}
      viewBox={`0 0 ${String(w)} ${String(height)}`}
      preserveAspectRatio="none"
      style={{ height }}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`trend-${tone}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="trend-top" />
          <stop offset="100%" className="trend-bottom" />
        </linearGradient>
      </defs>
      <path
        d={`M0,${String(height)} L${line.split(' ').join(' L')} L${String(w)},${String(height)} Z`}
        fill={`url(#trend-${tone})`}
      />
      <polyline points={line} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function MicroSpark({ values, tone }: { values: number[]; tone: Tone }) {
  const w = 100
  const h = 20
  const max = Math.max(...values, 0.0001)
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
  return (
    <svg className={`microspark microspark-${tone}`} viewBox={`0 0 ${String(w)} ${String(h)}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/* ── progress ─────────────────────────────────────────────────────────── */

/**
 * A single job's progress.
 *
 * `active` adds a travelling sheen. That is the one piece of ambient motion on
 * these pages and it is load-bearing: a paused torrent and a downloading
 * torrent at the same percentage are otherwise identical, and which one it is
 * is the question you opened the page to answer.
 */
export function Progress({
  pct,
  tone = 'accent',
  active = false,
  height = 6,
}: {
  pct: number | null
  tone?: Tone
  active?: boolean
  height?: number
}) {
  return (
    <span className={`progress progress-${tone}${active ? ' progress-active' : ''}`} style={{ height }}>
      <span className="progress-fill" style={{ width: `${String(Math.max(0, Math.min(100, pct ?? 0)))}%` }} />
    </span>
  )
}

/* ── pipeline ─────────────────────────────────────────────────────────── */

export type FlowStep = { label: string; value: string; hint?: string; active?: boolean }

/**
 * A left-to-right pipeline: indexers → downloader → importer → library.
 *
 * The connectors animate only between two stages that both have work in them,
 * which turns the row into a live read of where the queue is actually sitting.
 * A stalled import shows as a still connector with a non-zero count behind it.
 */
export function Flow({ steps }: { steps: FlowStep[] }) {
  return (
    <ol className="flow">
      {steps.map((s, i) => (
        <li key={s.label} className={s.active === true ? 'flow-step flow-step-live' : 'flow-step'}>
          <div className="flow-node">
            <strong>{s.value}</strong>
            <span>{s.label}</span>
            {s.hint !== undefined && <em>{s.hint}</em>}
          </div>
          {i < steps.length - 1 && (
            <span
              className={
                s.active === true && steps[i + 1]?.active === true ?
                  'flow-link flow-link-live'
                : 'flow-link'
              }
              aria-hidden="true"
            />
          )}
        </li>
      ))}
    </ol>
  )
}

/* ── small parts ──────────────────────────────────────────────────────── */

export function Pulse({ on, tone = 'ok' }: { on: boolean; tone?: Tone }) {
  return <span className={`pulse pulse-${tone}${on ? ' pulse-on' : ''}`} aria-hidden="true" />
}

export function Chip({ children, tone = 'muted' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`vchip vchip-${tone}`}>{children}</span>
}

/**
 * A labelled box. Distinct from the existing `Panel` (used on the app detail
 * pages) in that the body is not padded and the header can carry a live
 * reading — these panels hold charts that should touch their own edges.
 */
export function Board({
  title,
  icon,
  aside,
  span,
  fill,
  children,
}: {
  title: string
  icon?: string
  aside?: ReactNode
  /** Columns of the 12-wide category grid. Defaults to 6 (half width). */
  span?: 3 | 4 | 6 | 8 | 12
  /**
   * Grow to the height of the tallest board beside it, rather than to the
   * height of its own content.
   *
   * The grid is `align-items: start` because a board of four facts should not
   * be stretched into a wall of whitespace next to a chart. That is the right
   * default and the wrong one for a *pair* — two half-width boards of unequal
   * length leave a gap under the shorter one that reads as a missing panel.
   * Opt in on the board whose content can absorb the extra room.
   */
  fill?: boolean
  children: ReactNode
}) {
  return (
    <section
      className={fill === true ? 'board board-fill' : 'board'}
      style={{ ['--span' as string]: String(span ?? 6) }}
    >
      <header className="board-head">
        <h3>
          {icon !== undefined && (
            <span className="board-icon" aria-hidden="true">
              {icon}
            </span>
          )}
          {title}
        </h3>
        {aside !== undefined && <div className="board-aside">{aside}</div>}
      </header>
      <div className="board-body">{children}</div>
    </section>
  )
}

export function BoardGrid({ children }: { children: ReactNode }) {
  return <div className="board-grid">{children}</div>
}

/** Key/value rows inside a board — denser than the app pages' `Row`. */
export function Facts({ rows }: { rows: { k: string; v: ReactNode }[] }) {
  return (
    <dl className="facts">
      {rows.map((r) => (
        <div key={r.k}>
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  )
}
