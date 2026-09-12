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

/* ── the vocabulary the four tabs share ────────────────────────────────────
   The board vocabulary is one module now (components/tokens.ts): it is the
   same handful of strings on every category page, and was restated per file
   only while styles.css was being retired. Re-exported here so a tab still
   imports its own page's shared file. Below is what is genuinely the AI
   pages'. */
export { AXIS, EMPTY, FOOT, LIVE, MONO, NOTE } from '../../tokens'

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
