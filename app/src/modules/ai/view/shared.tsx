import type { ComponentProps, ReactNode } from 'react'
import { type CompareRow, latestRow } from '../../../components/service-head'
import { TableSection as HouseTableSection } from '../../../components/table-section'
import { cn } from '../../../lib/cn'
import type { VersionGap } from '../../../lib/dashboard/github'

export {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  CELL_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_LINK,
  TABLE_ROW,
  TABLE_ROW_LINK,
  TableGroup,
} from '../../../components/table'

/**
 * The latest release, paired with the PIN rather than with the running version.
 *
 * A departure from the shared `compareOf`, and on purpose: for LiteLLM, Open
 * WebUI and n8n the running number and the pin are different facts — the
 * first two are digests pinned against a moving tag, n8n an exact tag.
 * "Running" would restate the number already sitting beside it; "pinned by"
 * is the thing you would have to go and edit.
 */
export function comparePinned(gap: VersionGap, note: string): CompareRow[] {
  return [latestRow(gap), { k: 'Pinned by', v: null, note }]
}

/* ── the vocabulary the AI tabs share ──────────────────────────────────────
   The board vocabulary every category page uses lives in components/tokens.ts;
   it is re-exported here so a tab imports only its own page's shared file.
   Below is what is genuinely the AI pages'. */
export { AXIS, CAPTION, EMPTY, FOOT, LIVE, MONO, NOTE } from '../../../components/tokens'

/** A ranking: `RankRow`s, stacked. */
export const RANKS = 'm-0 flex list-none flex-col gap-0.5 p-0'

/* A flat list of named things, each led by a chip saying what kind it is and
   trailed by whatever detail that kind has. Rows of a table, not a stack of
   pills: a hairline between rows says what a filled capsule per fact said, at
   a fraction of the ink. */
export const ITEMS = 'm-0 flex list-none flex-col p-0'
export const ITEM =
  'flex min-w-0 items-center gap-2 px-0.5 py-2 text-[0.8rem] not-first:border-t not-first:border-hairline'
/** The name takes the slack, so the detail is pushed right without a spacer. */
export const ITEM_MAIN = 'min-w-0 flex-auto truncate text-foreground'
/** Truncates too: a tool's own description of itself is a sentence, and one
    long row must not widen the panel. */
export const ITEM_SIDE =
  'min-w-0 max-w-[60%] flex-initial truncate text-[0.72rem] text-muted-foreground tabular-nums'
export const ITEM_N = 'min-w-[1.4rem] text-right text-foreground tabular-nums'

/* The exception a panel's main list cannot hold: keys that never got an
   answer, the runs that failed. Warn rather than bad — it is something to look
   into, not something that is currently broken. */
export const REJECTED =
  'm-0 rounded-xl border border-warning/30 bg-warning/[0.07] px-3 py-2 text-[0.75rem] leading-[1.5] text-subdued [&_b]:font-semibold [&_b]:text-warning [&_b]:tabular-nums'

/* ── a table with a heading ────────────────────────────────────────────────
   The house TableSection (components/table-section.tsx), with the two things
   these pages add: the air a section keeps from the boards around it on the
   board grid, and a `foot` slot so the prose under a table (FOOT folds behind
   the title's ⓘ, CAPTION stays) is written beside its title rather than after
   a long table body. */

export function TableSection({
  foot,
  children,
  className,
  ...rest
}: ComponentProps<typeof HouseTableSection> & { foot?: ReactNode }) {
  return (
    <HouseTableSection {...rest} className={cn(SECTION_AIR, className)}>
      {children}
      {foot}
    </HouseTableSection>
  )
}

/** Between a section and the boards around it: 24px, the grid gap included. */
const SECTION_AIR = 'my-2 first:mt-0 last:mb-0'

/** A phone-only second line in a table's first cell: what its hidden columns held. */
export const PHONE_SUB =
  'm-0 mt-0.5 hidden text-[0.75rem] text-muted-foreground [overflow-wrap:anywhere] @max-[38rem]/table:block'
