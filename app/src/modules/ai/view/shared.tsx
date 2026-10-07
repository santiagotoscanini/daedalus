import type { ReactNode } from 'react'
import { ExplainToggle, useExplain } from '../../../components/explain'
import { type CompareRow, latestRow } from '../../../components/service-head'
import { SECTION_NOTE, SECTION_TITLE } from '../../../components/table'
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
   The section a list of things is drawn in: SECTION_TITLE over a TABLE, on the
   board grid beside the boards. Its explanation folds behind an ⓘ in the title,
   the way a Board's does, so moving a list out of a board into a table loses
   neither the prose nor the fold. */

export function TableSection({
  title,
  note,
  aside,
  foot,
  span = 12,
  children,
}: {
  title: string
  /** A visible line under the title: counts, a state. */
  note?: ReactNode
  /** Right of the title: a live reading. */
  aside?: ReactNode
  /** Under the table: FOOT folds behind the ⓘ, CAPTION stays. */
  foot?: ReactNode
  span?: 6 | 8 | 12
  children: ReactNode
}) {
  const explain = useExplain()
  return (
    <section
      className={cn(TABLE_SECTION, explain.body)}
      style={{ ['--span' as string]: String(span) }}
    >
      <h3 className={cn(SECTION_TITLE, 'mt-0 min-h-6')}>
        {title}
        <ExplainToggle
          open={explain.open}
          onToggle={explain.toggle}
          className="-my-1 hidden group-has-[.explain]/section:inline-flex"
        />
        {aside !== undefined && (
          <span className="ml-auto text-[0.78rem] font-normal text-muted-foreground">{aside}</span>
        )}
      </h3>
      {note !== undefined && <p className={SECTION_NOTE}>{note}</p>}
      {children}
      {foot !== undefined && <div className="mt-3 flex flex-col gap-2 px-1">{foot}</div>}
    </section>
  )
}

/** On the board grid like a Board, with a section's air above it. */
const TABLE_SECTION =
  'group/section min-w-0 my-6 first:mt-0 last:mb-0 [grid-column:span_var(--span,12)] max-[78rem]:[grid-column:span_min(12,calc(var(--span,12)*2))] max-[50rem]:[grid-column:span_12]'
