// The stat strip, the progress bar, and the small parts: the pulse dot and the chip.

import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { type Tone, toneStyle } from '../../lib/tone'
import { GLASS } from './board'
import { Spark } from './charts'

/** `StatStrip`'s box. The 1px grid gap IS the divider — the container's border
    colour showing through — which a per-cell border-left cannot promise once
    cells wrap. */
export const STAT_STRIP = `${GLASS} mb-4 grid grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] overflow-hidden`

/** One `Stat` cell. Every cell reserves the third row under the value, so a
    strip mixing cells that have a sparkline with cells that have a caption —
    or neither — keeps one baseline instead of stepping. */
export const STAT =
  'grid min-w-0 grid-rows-[auto_auto_1rem] content-start gap-1 px-5 pt-4 pb-4 shadow-[-1px_0_0_var(--hairline),0_-1px_0_var(--hairline)] [&>svg]:w-full'

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
  return <div className={STAT_STRIP}>{children}</div>
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
    <div className={STAT} title={title} style={tone === undefined ? undefined : toneStyle(tone)}>
      <span className="truncate text-[0.75rem] font-medium text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-[1.6rem] leading-[1.1] tracking-[-0.03em] tabular-nums max-[34rem]:text-[1.3rem] [font-weight:560] [overflow-wrap:anywhere]',
          tone !== undefined && 'text-(--tone)',
        )}
      >
        {value}
        {unit !== undefined && (
          <em className="ml-1 text-[0.75rem] font-normal tracking-normal text-muted-foreground not-italic">
            {unit}
          </em>
        )}
      </span>
      {spark !== undefined && spark.length > 1 ? (
        <Spark values={spark} tone={tone ?? 'muted'} />
      ) : sub !== undefined ? (
        <span className="truncate text-[0.72rem] leading-4 text-muted-foreground">{sub}</span>
      ) : null}
    </div>
  )
}

/* ── progress ─────────────────────────────────────────────────────────── */

/**
 * A single job's progress.
 *
 * `active` adds a travelling sheen — with `Pulse`, the only looping motion in
 * this file, and load-bearing: a paused torrent and a downloading
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
      className="block w-full overflow-hidden rounded-full bg-foreground/[0.08]"
      style={toneStyle(tone, { height })}
    >
      <span
        className={cn(
          'block h-full rounded-full bg-(--tone) [transition:width_400ms_ease] motion-reduce:transition-none',
          // The sheen is drawn from --foreground rather than white so it stays
          // a highlight in the light theme instead of vanishing into the page.
          active &&
            'animate-[sheen_1.6s_linear_infinite] [background-image:linear-gradient(100deg,transparent_20%,color-mix(in_srgb,var(--foreground)_22%,transparent)_50%,transparent_80%)] [background-size:240%_100%] motion-reduce:animate-none',
        )}
        style={{ width: `${String(Math.max(0, Math.min(100, pct ?? 0)))}%` }}
      />
    </span>
  )
}

/* ── small parts ──────────────────────────────────────────────────────── */

export function Pulse({ on, tone = 'ok' }: { on: boolean; tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-block size-[7px] flex-none rounded-full',
        on
          ? 'animate-[pulse-beat_2s_ease-in-out_infinite] bg-(--tone) motion-reduce:animate-none'
          : 'bg-muted-foreground',
      )}
      style={toneStyle(tone)}
      aria-hidden="true"
    />
  )
}

export function Chip({
  children,
  tone = 'muted',
  className,
  title,
}: {
  children: ReactNode
  tone?: Tone
  /** A shape of its own (the apps pages' round pill) or a quieter ink; the colour is `tone`. */
  className?: string
  title?: string
}) {
  // `ok` is the normal case, and the normal case is quiet: a green pill on
  // every healthy row made colour mean nothing. It keeps the pill's shape
  // (so a column of states still lines up) in neutral ink; only a state that
  // differs from normal is tinted.
  const quiet = tone === 'ok' || tone === 'muted'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-px text-[0.7rem] leading-[1.15rem] whitespace-nowrap font-[550] ring-1 ring-inset',
        quiet
          ? 'text-muted-foreground ring-hairline'
          : 'bg-[color-mix(in_oklch,var(--tone)_13%,transparent)] text-(--tone) ring-[color-mix(in_oklch,var(--tone)_24%,transparent)]',
        className,
      )}
      title={title}
      style={quiet ? undefined : toneStyle(tone)}
    >
      {children}
    </span>
  )
}
