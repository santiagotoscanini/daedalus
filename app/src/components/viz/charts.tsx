// The charts (rules in ./index.ts).
import { type ReactNode, useId } from 'react'
import { cn } from '../../lib/cn'
import { num } from '../../lib/format'
import { type Tone, toneStyle } from '../../lib/tone'
import { EMPTY } from '../tokens'

/* ── ring gauge ───────────────────────────────────────────────────────── */

/**
 * A proportion, as a ring.
 *
 * Chosen over a bar wherever the number is a *share of a whole* that the eye
 * should read without comparing to anything else — stills against video, a
 * library's share of its disk. The ring is drawn as a stroke-dasharray on a circle and grows from
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
    <div className="relative aspect-square flex-none" style={toneStyle(tone, { width: size })}>
      <svg viewBox="0 0 108 108" className="block h-full w-full" aria-hidden="true">
        <circle
          className="fill-none stroke-foreground/[0.08] [stroke-width:9]"
          cx="54"
          cy="54"
          r={r}
        />
        {pct !== null && (
          <circle
            // ring-sweep runs once on mount so the page reads as its numbers
            // arriving; the keyframe stays in styles.css because Tailwind has
            // no dasharray animation.
            className="animate-[ring-sweep_900ms_cubic-bezier(0.2,0.8,0.2,1)_both] fill-none stroke-(--tone) [stroke-linecap:round] [stroke-width:9] motion-reduce:animate-none"
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
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-[0.05rem]">
        <strong className="text-[0.95rem] tracking-[-0.01em] tabular-nums [font-weight:620]">
          {value}
        </strong>
        {label !== undefined && (
          <span className="text-[0.7rem] text-muted-foreground">{label}</span>
        )}
      </div>
    </div>
  )
}

/* ── bars ─────────────────────────────────────────────────────────────── */

type BarItem = { label: string; value: number; display?: string; tone?: Tone }

/**
 * A ranked list as proportional bars — "which of these is the big one".
 *
 * Scaled against the largest item rather than a total, because these lists are
 * almost always a top-N of a longer tail: normalising to the visible sum would
 * silently inflate every bar by however much was cut off.
 */
export function BarList({
  items,
  tone = 'muted',
  max,
  empty = 'no data',
}: {
  items: BarItem[]
  tone?: Tone
  /** Override the scale — for bars that must be comparable across panels. */
  max?: number
  empty?: string
}) {
  if (items.length === 0) return <p className={EMPTY}>{empty}</p>
  const ceiling = max ?? Math.max(...items.map((i) => i.value), 0.0001)

  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {items.map((i, n) => (
        <li
          // Two rows can share a label — a machine running two claude.exe —
          // and the same label twice is still two rows.
          key={`${i.label}#${String(n)}`}
          className="grid min-w-0 grid-cols-[minmax(5.5rem,40%)_1fr_auto] items-center gap-2.5"
          style={toneStyle(i.tone ?? tone)}
        >
          <span className="min-w-0 break-words text-[0.78rem] text-subdued" title={i.label}>
            {i.label}
          </span>
          <span className="block h-1.5 min-w-0 overflow-hidden rounded-full bg-foreground/[0.08]">
            <span
              className="block h-full origin-left animate-[bar-grow_700ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-full bg-(--tone) motion-reduce:animate-none"
              style={{ width: `${String(Math.max(1.5, (i.value / ceiling) * 100))}%` }}
            />
          </span>
          <span className="text-[0.8rem] whitespace-nowrap tabular-nums [font-weight:560]">
            {i.display ?? i.value.toLocaleString('en-US')}
          </span>
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
 * bar cannot: what it cost, how slowly it went, when it was last seen — what
 * a `BarList` has no room for.
 *
 * Shared by the gateway's callers, n8n's workflows, Prowlarr's indexers and
 * Seerr's requesters because they are the same object: a named thing, a count worth comparing, and
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
    // Fixed name and count tracks, not `auto`. Each row is its own grid
    // container, so a content-sized column is measured per row — the bars
    // would start at a different x on every line and stop at a different one,
    // which is the entire comparison this list exists to make.
    <li className="grid min-w-0 grid-cols-[9.5rem_minmax(2rem,1fr)_2.6rem] items-center gap-x-2.5 gap-y-0.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/[0.04]">
      <span className="flex min-w-0 items-baseline gap-1.5 text-[0.8rem]">
        <span
          // A name that cannot be read at face value — an internal credential,
          // or a hash — carries its explanation on a hover, and says so with
          // a dotted underline, the same promise the Disks tab's model names make.
          className={cn('min-w-0 truncate', note !== null && 'cursor-help border-b border-dotted')}
          title={note ?? name}
        >
          {name}
        </span>
        {badges.map((b) => (
          <em
            key={b.text}
            // Warn, not bad: a state that changes what the numbers mean is
            // something to look into, not something that is on fire. Muted is
            // "deliberately switched off", which explains the silence rather
            // than reporting it.
            className={cn(
              'flex-none rounded-full px-1.5 text-[0.68rem] leading-4 not-italic ring-1 ring-inset [font-weight:550]',
              b.tone === 'muted'
                ? 'text-muted-foreground ring-hairline'
                : 'bg-warning/10 text-warning ring-warning/25',
            )}
            title={b.why ?? note ?? undefined}
          >
            {b.text}
          </em>
        ))}
      </span>
      <span className="block h-1 overflow-hidden rounded-full bg-foreground/[0.08]">
        <span
          // Same growth as every other bar on these pages — `bar-grow` scales
          // on X from the left, so the origin has to be set for it to read as
          // filling rather than as sliding in.
          className="block h-full origin-left animate-[bar-grow_600ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-full bg-muted-foreground/55 motion-reduce:animate-none"
          style={{ width: `${String(Math.max(1.5, (value / max) * 100))}%` }}
        />
      </span>
      <span className="text-right text-[0.8rem] whitespace-nowrap tabular-nums">{num(value)}</span>
      {/* Interpuncts are generated between the items rather than typed, so a
          caller with no tokens and no latency does not trail a separator into
          empty space. */}
      <span className="col-span-full flex min-w-0 flex-wrap gap-x-1.5 gap-y-0 text-[0.72rem] text-muted-foreground tabular-nums [&>span+span]:before:mr-1.5 [&>span+span]:before:text-border [&>span+span]:before:content-['·']">
        {meta}
      </span>
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
  tone = 'muted',
  height = 84,
  empty = 'no data',
}: {
  points: Column[]
  tone?: Tone
  height?: number
  empty?: string
}) {
  if (points.length === 0) return <p className={EMPTY}>{empty}</p>
  const max = Math.max(...points.map((p) => p.value), 0.0001)

  return (
    <div className="flex w-full items-end gap-[2px]" style={toneStyle(tone, { height })}>
      {points.map((p, i) => (
        <div
          key={`${p.label}-${String(i)}`}
          // The flag rule is drawn under the baseline and tracks the bar's own
          // cap, not the slot, so it sits under the column it belongs to
          // rather than under the gap on either side of it.
          className={cn(
            'group flex h-full min-w-0 flex-1 items-end justify-center',
            p.flag === true &&
              'relative after:absolute after:-bottom-[3px] after:left-1/2 after:h-0.5 after:w-[min(100%,2.75rem)] after:-translate-x-1/2 after:rounded-[1px] after:bg-danger',
          )}
          title={`${p.label}: ${p.display ?? p.value.toLocaleString('en-US')}`}
        >
          <span
            // Capped and centred rather than filling its slot: a fortnight
            // across a full-width board gives each column eighty-odd pixels,
            // and a saturated block that wide reads as a filled area chart.
            className="block w-full max-w-[2.75rem] origin-bottom animate-[col-grow_550ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-t-[2px] bg-(--tone) opacity-85 group-hover:opacity-100 motion-reduce:animate-none"
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
  tone = 'muted',
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

  if (values.length < 2) return <p className={EMPTY}>{empty}</p>

  const w = 600
  const max = Math.max(...values, 0.0001)
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => [i * step, height - (v / max) * (height - 6) - 3] as const)
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')

  return (
    <svg
      // The stroke is scoped to the polyline: `stroke` inherits, and on the
      // svg it would outline the gradient-filled path too.
      className="block w-full [&>polyline]:stroke-(--tone)"
      viewBox={`0 0 ${String(w)} ${String(height)}`}
      preserveAspectRatio="none"
      style={toneStyle(tone, { height })}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="[stop-color:var(--tone)] [stop-opacity:0.28]" />
          <stop offset="100%" className="[stop-color:var(--tone)] [stop-opacity:0]" />
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
    // No width: the box it lands in decides. `Stat` stretches it across the
    // cell; the app cards size it from its height and push it right.
    <svg
      className="h-4 self-end stroke-(--tone)"
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      style={toneStyle(tone)}
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
