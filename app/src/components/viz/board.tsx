// The board: a titled panel on the 12-wide grid, and the two fact layouts that fill one.

import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { type Tone, toneStyle } from '../../lib/tone'
import { EXPLAIN_FOLDED, ExplainToggle } from '../explain'
import { Glyph, type GlyphName, isGlyph } from '../glyph'

/** The glass panel every board, card and strip is drawn as: a veil over the
    canvas (`--surface`), a hairline edge, a lit top edge and a soft drop.
    One constant so a board and a settings card cannot drift apart. */
export const GLASS =
  'rounded-2xl border border-hairline bg-surface shadow-[inset_0_1px_0_var(--hairline-hi),var(--board-shadow)]'

/** `Board`'s section. Full width on a phone, double the declared span on a
    laptop, the declared span on a desktop — the board grid is 12 wide at
    every size. */
export const BOARD = cn(
  GLASS,
  'group/board relative flex min-w-0 flex-col overflow-hidden [grid-column:span_var(--span,6)] max-[78rem]:[grid-column:span_clamp(6,calc((var(--span,6)-6)*12),12)] max-[50rem]:[grid-column:span_12]',
)

/** `Board`'s header row. No rule under it: the title's weight and the
    space below it are the separation, as in a well-set page. */
export const BOARD_HEAD =
  // Wraps: on a narrow board the right-hand reading drops under the title
  // instead of squeezing it to an ellipsis (titles must not truncate).
  'flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 px-5 pt-3.5 pb-0'

/** `Board`'s body. A query container, so controls inside a board lay
    themselves out from the width they actually got: one viewport width gives
    a board anywhere from a quarter of the page to all of it. `flex-1` puts
    the grid row's surplus here rather than under the header. */
export const BOARD_BODY = '@container/board flex flex-1 flex-col gap-3 px-5 pt-3 pb-5'

/** `BoardGrid`'s grid. Boards in the same row share a bottom edge: `stretch`
    is the grid default and it is left alone deliberately. Which sibling is
    taller depends on live data, on the width that decides how a list wraps,
    and on whether a reader has opened a <details> — so every per-board `fill`
    opt-in was a guess about a value that changes after the guess. */
// Dense between the drawer and 78rem: boards there are 6 or 12 wide, and a lone
// half-width board pulls the next half-width one up beside it.
export const BOARD_GRID = 'grid grid-cols-12 gap-4 max-[78rem]:[grid-auto-flow:dense]'

/** A board's title. Shared with the skeleton so nothing shifts on load. */
export const BOARD_TITLE =
  'm-0 flex min-w-0 items-center gap-2 text-[0.875rem] text-foreground tracking-[-0.01em] [font-weight:560]'

/**
 * A labelled box on a `BoardGrid`: a title, an optional `aside` in the header
 * (a live reading, a count), and a body laid out as a column.
 */
export function Board({
  title,
  icon,
  aside,
  span,
  children,
}: {
  title: string
  /** A name from components/glyph.tsx, drawn as an SVG — or any other string,
      rendered as text. The tail of one-off Unicode glyphs is long and stays
      typed; `GlyphName | (string & {})` keeps the names in autocomplete
      without rejecting it. */
  icon?: GlyphName | (string & {})
  aside?: ReactNode
  /** Columns of the 12-wide `BoardGrid`. Defaults to 6 (half width). */
  span?: 3 | 4 | 6 | 8 | 9 | 12
  children: ReactNode
}) {
  return (
    <section className={BOARD} style={{ ['--span' as string]: String(span ?? 6) }}>
      <header className={BOARD_HEAD}>
        {/* Sentence case at reading weight, not an ALL-CAPS eyebrow: a page
            holds eight of these, and eight tracked-out capitals read as
            decoration. The icon went with the caps — a card is named by its
            title — so the slot is kept but not drawn. */}
        <h3 className={BOARD_TITLE}>
          {icon !== undefined && (
            <span className="hidden" aria-hidden="true">
              {isGlyph(icon) ? <Glyph name={icon} /> : icon}
            </span>
          )}
          <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
          <ExplainToggle className="-my-1 hidden group-has-[.explain]/board:inline-flex opacity-0 group-hover/board:opacity-100" />
        </h3>
        {aside !== undefined && <div className="min-w-0 text-[0.78rem]">{aside}</div>}
      </header>
      <div className={cn(BOARD_BODY, EXPLAIN_FOLDED)}>{children}</div>
    </section>
  )
}

export function BoardGrid({ children }: { children: ReactNode }) {
  return <div className={BOARD_GRID}>{children}</div>
}

/**
 * A line of small labelled figures — the horizontal counterpart to `Facts`.
 *
 * For a handful of numbers that are read ACROSS rather than compared against
 * each other: what a model has done, what a gateway carried today. The reason
 * this exists rather than a headline band of large stat cards is that a stat
 * card is a claim on the reader's attention, and four of them spend a whole
 * band of the page saying things nobody came to look at. As a measure line the same numbers cost one
 * row inside the panel they belong to.
 *
 * A tone is for the one figure that can be a FAULT (failures, an expiry). Every
 * other figure stays in text ink — colouring all of them would make the line a
 * decoration and the exception invisible.
 */
export function Measures({ items }: { items: { k: string; v: ReactNode; tone?: Tone }[] }) {
  return (
    <dl className="m-0 flex flex-wrap gap-x-7 gap-y-2">
      {items.map((m) => (
        <div
          key={m.k}
          className="flex flex-col gap-[0.05rem]"
          style={m.tone === undefined ? undefined : toneStyle(m.tone)}
        >
          <dt className="text-[0.72rem] text-muted-foreground">{m.k}</dt>
          <dd
            className={cn(
              'm-0 text-[0.95rem] tabular-nums tracking-[-0.01em] [font-weight:520]',
              m.tone === undefined ? 'text-foreground' : 'text-(--tone)',
            )}
          >
            {m.v}
          </dd>
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
    <dl
      className={cn(
        'm-0',
        list === true
          ? // Hairline separators instead of a box per row: at eight rows the
            // boxes were most of what the panel drew.
            'block'
          : 'grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-5 gap-y-3',
      )}
    >
      {rows.map((r) => (
        <div
          key={r.k}
          className={cn(
            'min-w-0',
            list === true
              ? 'flex flex-row flex-wrap items-baseline justify-between gap-x-[1.25rem] gap-y-[0.2rem] border-t border-hairline py-2 first:border-t-0 first:pt-0'
              : 'flex flex-col gap-[0.05rem]',
          )}
        >
          <dt
            className={cn(
              'text-muted-foreground',
              list === true ? 'flex-none text-[0.82rem]' : 'truncate text-[0.75rem]',
            )}
          >
            {r.k}
          </dt>
          <dd
            className={cn(
              'm-0',
              list === true
                ? 'min-w-0 text-right text-[0.84rem] [font-weight:450]'
                : 'text-[0.9375rem] tracking-[-0.01em] tabular-nums [font-weight:520] [overflow-wrap:anywhere]',
            )}
          >
            {r.v}
          </dd>
        </div>
      ))}
    </dl>
  )
}
