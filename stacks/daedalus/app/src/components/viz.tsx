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

import { type ReactNode, useId } from 'react'

import { num } from '../lib/format'

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

/**
 * One row of a ranking, in two lines.
 *
 * The bar carries the comparison — the whole question a ranking answers is
 * which of these is the big one — and the line under it carries everything the
 * bar cannot: what it cost, how slowly it went, when it was last seen. A bar
 * list alone said only "n8n is the big one", which was true on the first read
 * and had nothing to add on any later one.
 *
 * Shared by the gateway's callers, n8n's workflows and Prowlarr's indexers
 * because they are the same object: a named thing, a count worth comparing, and
 * a few facts that only make sense next to it.
 *
 * `note` is the answer to "what IS this row" — a bare hash, a name that turns
 * out to be six services sharing one credential — and it hangs off the name
 * rather than the caption, where it would have to be written once per case and
 * read every time. `badges` are for the states that change what the numbers
 * mean: a key the gateway no longer holds, a schedule that has stopped firing,
 * an indexer that is answering but failing every grab. A list rather than one,
 * because those are independent — a workflow can be both stalled and
 * unpublished, and picking one to show would hide the other.
 */
export function RankRow({
  name,
  note = null,
  badges = [],
  value,
  max,
  meta,
}: {
  name: string
  note?: string | null
  badges?: readonly { text: string; tone: 'warn' | 'muted'; why?: string }[]
  value: number
  max: number
  meta: ReactNode
}) {
  return (
    <li className="rank">
      <span className={note === null ? 'rank-name' : 'rank-name rank-noted'}>
        <span title={note ?? name}>{name}</span>
        {badges.map((b) => (
          <em
            key={b.text}
            className={b.tone === 'muted' ? 'is-muted' : undefined}
            title={b.why ?? note ?? undefined}
          >
            {b.text}
          </em>
        ))}
      </span>
      <span className="rank-track">
        <span
          className="rank-fill"
          style={{ width: `${String(Math.max(1.5, (value / max) * 100))}%` }}
        />
      </span>
      <span className="rank-n">{num(value)}</span>
      <span className="rank-meta">{meta}</span>
    </li>
  )
}

/* ── time series ──────────────────────────────────────────────────────── */

export type Column = {
  label: string
  value: number
  display?: string
  /**
   * Mark this bucket as faulted — a hairline in the bad tone under the column.
   *
   * A status marker, not a second series: it says "something went wrong on this
   * day" without competing with the height for the eye. Encoding failures as a
   * second stacked colour would make a bad day look like a big day, which is
   * the opposite of what it means.
   */
  flag?: boolean
}

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
          className={p.flag === true ? 'columns-col columns-col-flag' : 'columns-col'}
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
  // useId, not the tone: SVG ids are document-global, and a page renders many
  // Trends. Keyed by tone, a chart resolved `url(#…)` into whichever sibling
  // rendered first — invalid markup, and Safari drops the fill entirely when
  // that sibling is off-screen.
  const gradientId = useId()

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
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="trend-top" />
          <stop offset="100%" className="trend-bottom" />
        </linearGradient>
      </defs>
      <path
        d={`M0,${String(height)} L${line.split(' ').join(' L')} L${String(w)},${String(height)} Z`}
        fill={`url(#${gradientId})`}
      />
      <polyline points={line} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/**
 * A short series as a bare line, scaled to its own band.
 *
 * The band, not zero, is the whole point. A container resting at a steady
 * 83 MB drawn against zero is a filled rectangle — a shape that says "full"
 * about a number that means "unchanged". Against the series' own minimum and
 * maximum the same numbers are a flat line, which is the true statement.
 *
 * A band narrower than 2% of its midpoint is drawn dead flat rather than
 * stretched to fill the box: below that the shape is quantisation noise on a
 * resting value, and magnifying it into a mountain range invents movement
 * that is not there. Stroke only — a fill reads as a quantity, and this is a
 * shape.
 */
export function Spark({
  values,
  tone = 'muted',
  width = 64,
  height = 18,
}: {
  values: number[]
  tone?: Tone
  width?: number
  height?: number
}) {
  if (values.length < 2) return null

  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const mid = (lo + hi) / 2
  const flat = mid === 0 || (hi - lo) / Math.abs(mid) < 0.02
  const step = width / (values.length - 1)
  const pts = values.map((v, i) => {
    const y = flat ? height / 2 : height - 1.5 - ((v - lo) / (hi - lo)) * (height - 3)
    return `${(i * step).toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <svg
      className={`spark2 spark2-${tone}`}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={pts.join(' ')}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/**
 * The row of live readings at the top of a page — one bordered strip with
 * hairline dividers, not a grid of cards.
 *
 * One element rather than N is what keeps the row honest at any count and any
 * width: the cells share a baseline because they share a grid row, and the
 * divider is the 1px gap showing the container through, so it lands correctly
 * however they wrap. A card per number cannot promise either — an auto-fitting
 * grid of six leaves an orphan on the second row, and a card carrying a chart
 * stands at twice the height of one carrying a caption.
 */
export function StatStrip({ children }: { children: ReactNode }) {
  return <div className="strip">{children}</div>
}

/**
 * One reading in a `StatStrip`.
 *
 * `sub` and `spark` are alternatives rather than a stack: the slot under the
 * value is one line tall, which is what keeps every cell in the strip the same
 * height. A cell wanting both is a cell that should be a board.
 */
export function Stat({
  label,
  value,
  unit,
  tone,
  spark,
  sub,
  title,
}: {
  label: string
  value: ReactNode
  unit?: string
  /** Colours the value. For a reading that can be a FAULT, not for decoration. */
  tone?: Tone
  spark?: number[]
  sub?: ReactNode
  /** The working behind the number, on hover. */
  title?: string
}) {
  return (
    <div className={tone === undefined ? 'stat' : `stat stat-${tone}`} title={title}>
      <span className="stat-k">{label}</span>
      <span className="stat-v">
        {value}
        {unit !== undefined && <em>{unit}</em>}
      </span>
      {spark !== undefined && spark.length > 1 ? (
        <Spark values={spark} tone={tone ?? 'muted'} />
      ) : sub !== undefined ? (
        <span className="stat-sub">{sub}</span>
      ) : null}
    </div>
  )
}

function MicroSpark({ values, tone }: { values: number[]; tone: Tone }) {
  const w = 100
  const h = 20
  const max = Math.max(...values, 0.0001)
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
  return (
    <svg
      className={`microspark microspark-${tone}`}
      viewBox={`0 0 ${String(w)} ${String(h)}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={pts.join(' ')}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
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
    <span
      className={`progress progress-${tone}${active ? ' progress-active' : ''}`}
      style={{ height }}
    >
      <span
        className="progress-fill"
        style={{ width: `${String(Math.max(0, Math.min(100, pct ?? 0)))}%` }}
      />
    </span>
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
  children,
}: {
  title: string
  icon?: string
  aside?: ReactNode
  /** Columns of the 12-wide category grid. Defaults to 6 (half width). */
  span?: 3 | 4 | 6 | 8 | 9 | 12
  children: ReactNode
}) {
  return (
    <section className="board" style={{ ['--span' as string]: String(span ?? 6) }}>
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

/**
 * A line of small labelled figures — the horizontal counterpart to `Facts`.
 *
 * For a handful of numbers that are read ACROSS rather than compared against
 * each other: what a model has done, what a gateway carried today. The reason
 * this exists rather than four `BigStat`s is that a stat card is a claim on the
 * reader's attention, and four of them spend a whole band of the page saying
 * things nobody came to look at. As a measure line the same numbers cost one
 * row inside the panel they belong to.
 *
 * A tone is for the one figure that can be a FAULT (failures, an expiry). Every
 * other figure stays in text ink — colouring all of them would make the line a
 * decoration and the exception invisible.
 */
export function Measures({ items }: { items: { k: string; v: ReactNode; tone?: Tone }[] }) {
  return (
    <dl className="measures">
      {items.map((m) => (
        <div key={m.k} className={m.tone === undefined ? undefined : `measures-${m.tone}`}>
          <dt>{m.k}</dt>
          <dd>{m.v}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Key/value rows inside a board.
 *
 * Two shapes, because the content genuinely has two shapes. The default packs
 * short readings into an auto-fitting grid with the label above the value —
 * right for four numbers read across. `list` puts one pair per line, label
 * left and value right, which is what a settings or connection panel wants:
 * the values there are identifiers, not quantities, and a hostname or an image
 * reference in a 9rem column is a wrapped mess.
 */
export function Facts({ rows, list }: { rows: { k: string; v: ReactNode }[]; list?: boolean }) {
  return (
    <dl className={list === true ? 'facts facts-list' : 'facts'}>
      {rows.map((r) => (
        <div key={r.k}>
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  )
}
