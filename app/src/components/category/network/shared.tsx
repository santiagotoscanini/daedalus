import type { Tone } from '../../viz'

/* ── shared ───────────────────────────────────────────────────────────── */

/**
 * A tri-state health as a dot tone.
 *
 * `null` is "could not be read", which is grey — deliberately not the same
 * claim as down, and the state a route lands in when the thing that would
 * answer for it is itself unreachable.
 */
export function tone(ok: boolean | null): Tone | null {
  return ok === null ? null : ok ? 'ok' : 'bad'
}

/* ── the vocabulary the six tabs share ────────────────────────────────────
   Each of these was one class in styles.css before the Tailwind migration,
   and each is read on every tab of this category. They stay here rather than
   being retyped per file for the reason they were classes in the first place:
   a board caption set at 0.73rem on one tab and 0.75rem on the next reads as a
   rendering fault, and nothing in a diff would show it. */

/** The caption under a board's content. */
export const FOOT =
  'm-0 mt-[0.15rem] text-[0.73rem] leading-[1.45] text-(--dim) [overflow-wrap:anywhere]'

/** The small grey reading in a board's header. */
export const NOTE = 'text-[0.73rem] text-(--dim)'

/** A heading inside a board's body. */
export const SUB =
  'mx-0 mt-[0.35rem] -mb-[0.2rem] text-[0.73rem] font-[550] tracking-normal text-(--dim)'

/** A board header that carries a live dot beside its reading. */
export const LIVE =
  'inline-flex items-center gap-[0.35rem] text-[0.73rem] whitespace-nowrap text-(--text-muted)'

/** "There is nothing to draw here." */
export const EMPTY =
  'm-0 py-[0.9rem] text-center text-[0.8rem] text-(--dim) [overflow-wrap:anywhere]'

/**
 * An identifier: a hostname, an address, a hardware address.
 *
 * The size is an `em` on purpose — a monospace face at the size of the sans
 * text around it reads a step larger, so every one of these shrinks against
 * whatever it sits in. A row that sets its own size overrides it.
 */
export const MONO = 'font-mono text-[0.86em] [overflow-wrap:anywhere]'

/** The two dates under a column chart, and what is being counted. */
export const AXIS =
  'm-0 -mt-[0.35rem] flex justify-between gap-[0.6rem] text-[0.66rem] text-(--dim) tabular-nums'

/* Rows of a table, not a stack of pills: a hairline between rows says what a
   filled capsule per fact said, at a fraction of the ink. */

/** The list. */
export const ROWS = 'm-0 flex list-none flex-col p-0'

/** One row of it. */
export const ROW =
  'flex min-w-0 items-center gap-[0.45rem] px-[0.1rem] py-[0.34rem] text-[0.77rem] not-first:border-t not-first:border-(--border-soft)'

/** The name in a row. Takes the slack, so the detail is pushed right. */
export const MAIN = 'min-w-0 flex-auto truncate text-foreground'

/** The detail at the end of a row. Truncates: a record's content is 200
    characters of base64 nobody reads on a dashboard. */
export const SIDE =
  'min-w-0 max-w-[60%] flex-initial truncate text-[0.68rem] text-(--dim) tabular-nums'

/** The count at the end of a row. */
export const N = 'min-w-[1.4rem] text-right text-foreground tabular-nums'

/** A folded group: the disclosure triangle, and the summary it sits in. Size
    and colour are left to the caller — a fold inside a board and the fold that
    ends a ranked list are the same mechanism at two weights. */
export const FOLD =
  "[&>summary]:flex [&>summary]:cursor-pointer [&>summary]:list-none [&>summary]:items-center [&>summary]:gap-[0.45rem] [&>summary]:px-[0.1rem] [&>summary]:py-[0.3rem] [&>summary::-webkit-details-marker]:hidden [&>summary]:before:text-[0.7rem] [&>summary]:before:text-(--dim) [&>summary]:before:transition-transform [&>summary]:before:duration-[0.12s] [&>summary]:before:ease-[ease] [&>summary]:before:content-['▸'] [&[open]>summary]:before:rotate-90"

/** The tail of a list, folded. Set apart from the rows above it so the fold
    reads as the end of the list rather than as another row in it. */
export const MORE = `${FOLD} mt-[0.4rem] border-t border-(--border-soft) [&>summary]:text-[0.72rem] [&>summary]:text-(--text-muted)`

/** A folded group inside a board. */
export const GROUP = `${FOLD} [&>summary]:text-[0.78rem] [&>summary]:text-foreground`

/**
 * The one link a page header carries.
 *
 * The Geist signature: the primary action is the FOREGROUND colour, not the
 * brand one — the accent identifies the app, this identifies the one thing you
 * came to press. It was a literal near-black label, which on a light theme is
 * black on black; `text-background` is the same pixel in dark and readable in
 * both.
 */
export const ACTION =
  'inline-flex cursor-pointer items-center rounded-[7px] border border-foreground bg-foreground px-[0.85rem] py-[0.42rem] text-[0.84rem] font-[550] whitespace-nowrap text-background no-underline transition-colors hover:border-foreground/85 hover:bg-foreground/85 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-dim)'

/** The bar that carries a tab's route/tunnel switch. The switch is always at
    the right, whether or not anything sits to its left — `ml-auto` on the last
    child does both cases, where `justify-between` would park a lone child at
    the start. */
export const SWITCH_BAR =
  'mx-0 mt-7 mb-6 flex flex-wrap items-center gap-4 border-b border-border pb-[0.9rem] [&>*:last-child]:ml-auto'
