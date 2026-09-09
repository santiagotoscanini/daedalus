import type { VersionGap } from '../../../lib/dashboard/github'
import { type CompareRow, latestRow } from '../../service-head'

/**
 * The working, paired with the PIN rather than with the running version.
 *
 * The one place this dashboard departs from the shared `compareOf`, and on
 * purpose: on these four the running number and the pin are different facts.
 * Lemonade is installed on Windows and is in no flake at all; LiteLLM and Open
 * WebUI are digests pinned against a moving tag. "Running" would restate the
 * number already sitting two centimetres to the left; "pinned by" is the thing
 * you would have to go and edit.
 */
export function comparePinned(gap: VersionGap, note: string): CompareRow[] {
  return [latestRow(gap), { k: 'Pinned by', v: null, note }]
}

/* ── the vocabulary the four tabs share ───────────────────────────────────
   Each of these was one class in styles.css, read on every AI tab. Spelled
   once for the reason they were classes: a caption at 0.73rem on one tab and
   0.75rem on the next reads as a rendering fault, and no diff would show it. */

/** The reading in a board's header. */
export const NOTE = 'text-[0.73rem] text-muted-foreground'

/** A board header that carries a live dot beside its reading. */
export const LIVE =
  'inline-flex items-center gap-[0.35rem] text-[0.73rem] whitespace-nowrap text-(--text-muted)'

/** The caption under a board's content. */
export const FOOT =
  'm-0 mt-[0.15rem] text-[0.73rem] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]'

/** "There is nothing here", said out loud. */
export const EMPTY =
  'm-0 py-[0.9rem] text-center text-[0.8rem] text-muted-foreground [overflow-wrap:anywhere]'

/** An identifier: no spaces to break at, so it is allowed to break anywhere. */
export const MONO = 'font-mono text-[0.86em] [overflow-wrap:anywhere]'

/** The two dates under a column chart, and what is being counted. */
export const AXIS =
  'm-0 -mt-[0.35rem] flex justify-between gap-[0.6rem] text-[0.66rem] text-(--dim) tabular-nums'

/** A ranking: `RankRow`s, stacked. */
export const RANKS = 'm-0 flex list-none flex-col gap-[0.1rem] p-0'

/* A flat list of named things, each led by a chip saying what kind it is and
   trailed by whatever detail that kind has. Rows of a table, not a stack of
   pills: a hairline between rows says what a filled capsule per fact said, at
   a fraction of the ink. */
export const ITEMS = 'm-0 flex list-none flex-col p-0'
export const ITEM =
  'flex min-w-0 items-center gap-[0.45rem] px-[0.1rem] py-[0.34rem] text-[0.77rem] not-first:border-t not-first:border-(--border-soft)'
/** The name takes the slack, so the detail is pushed right without a spacer. */
export const ITEM_MAIN = 'min-w-0 flex-auto truncate text-foreground'
/** Truncates too: a tool's own description of itself is a sentence, and one
    long row must not widen the panel. */
export const ITEM_SIDE =
  'min-w-0 max-w-[60%] flex-initial truncate text-[0.68rem] text-(--dim) tabular-nums'
export const ITEM_N = 'min-w-[1.4rem] text-right text-foreground tabular-nums'

/* The exception a panel's main list cannot hold: keys that never got an
   answer, the runs that failed. Warn rather than bad — it is something to look
   into, not something that is currently broken. */
export const REJECTED =
  'mx-0 mt-[0.5rem] mb-0 rounded-[7px] border border-warning/32 bg-warning/7 px-[0.55rem] py-[0.4rem] text-[0.72rem] leading-[1.45] text-(--text-muted) [&_b]:font-semibold [&_b]:text-warning [&_b]:tabular-nums'
