// The board: a titled panel on the 12-wide grid, and the two fact layouts that fill one.

import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { type Tone, toneStyle } from '../../lib/tone'
import { Glyph, type GlyphName, isGlyph } from '../glyph'

/** `Board`'s section. Full width on a phone, double the declared span on a
    laptop, the declared span on a desktop — the board grid is 12 wide at
    every size. */
export const BOARD =
  'flex min-w-0 flex-col overflow-hidden rounded-lg border border-subtle bg-card [grid-column:span_var(--span,6)] max-[78rem]:[grid-column:span_min(12,calc(var(--span,6)*2))] max-[50rem]:[grid-column:span_12]'

/** `Board`'s header row. */
export const BOARD_HEAD =
  'flex items-baseline justify-between gap-[0.6rem] border-b border-subtle px-[0.95rem] pt-[0.7rem] pb-[0.55rem]'

/** `Board`'s body. A query container, so controls inside a board lay
    themselves out from the width they actually got: one viewport width gives
    a board anywhere from a quarter of the page to all of it. `flex-1` puts
    the grid row's surplus here rather than under the header. */
export const BOARD_BODY =
  '@container/board flex flex-1 flex-col gap-[0.7rem] px-[0.95rem] pt-[0.85rem] pb-[0.95rem]'

/** `BoardGrid`'s grid. Boards in the same row share a bottom edge: `stretch`
    is the grid default and it is left alone deliberately. Which sibling is
    taller depends on live data, on the width that decides how a list wraps,
    and on whether a reader has opened a <details> — so every per-board `fill`
    opt-in was a guess about a value that changes after the guess. */
export const BOARD_GRID = 'grid grid-cols-12 gap-[0.8rem]'

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
        <h3 className="m-0 flex items-center gap-2 text-[0.85rem] [font-weight:550]">
          {icon !== undefined && (
            <span className="hidden" aria-hidden="true">
              {isGlyph(icon) ? <Glyph name={icon} /> : icon}
            </span>
          )}
          {title}
        </h3>
        {aside !== undefined && <div>{aside}</div>}
      </header>
      <div className={BOARD_BODY}>{children}</div>
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
    <dl className="m-0 flex flex-wrap gap-x-[1.4rem] gap-y-[0.4rem]">
      {items.map((m) => (
        <div
          key={m.k}
          className="flex flex-col gap-[0.05rem]"
          style={m.tone === undefined ? undefined : toneStyle(m.tone)}
        >
          <dt className="text-[0.6rem] tracking-[0.08em] text-muted-foreground uppercase">{m.k}</dt>
          <dd
            className={cn(
              'm-0 text-[0.85rem] tabular-nums',
              m.tone === undefined ? 'text-subdued' : 'text-(--tone)',
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
          : 'grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-x-4 gap-y-[0.45rem]',
      )}
    >
      {rows.map((r) => (
        <div
          key={r.k}
          className={cn(
            'min-w-0',
            list === true
              ? 'flex flex-row flex-wrap items-baseline justify-between gap-x-[1.25rem] gap-y-[0.2rem] border-t border-subtle py-[0.45rem] first:border-t-0 first:pt-0'
              : 'flex flex-col gap-[0.05rem]',
          )}
        >
          <dt
            className={cn(
              'text-muted-foreground',
              list === true ? 'flex-none text-[0.82rem]' : 'truncate text-[0.73rem]',
            )}
          >
            {r.k}
          </dt>
          <dd
            className={cn(
              'm-0',
              list === true
                ? 'min-w-0 text-right text-[0.84rem] [font-weight:450]'
                : 'text-[0.92rem] tabular-nums [font-weight:550] [overflow-wrap:anywhere]',
            )}
          >
            {r.v}
          </dd>
        </div>
      ))}
    </dl>
  )
}
