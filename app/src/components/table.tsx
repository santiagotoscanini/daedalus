import { cn } from '../lib/cn'

// The house table: the Apps list's vocabulary, for every list of things.
//
// A list of things you run or watch is read DOWN its columns, so it is a
// table with one column grid shared by the head and every row — never a wall
// of cards and never a flex row whose columns drift with their content.
//
//   <ul className={TABLE}>
//     <li className={cn(GRID, TABLE_HEAD)}>…labels…</li>
//     <li className={cn(GRID, TABLE_ROW)}>…cells…</li>
//     <TableGroup title="Control plane" note="Declared in Nix" />
//     <li className={cn(GRID, TABLE_ROW)}>…</li>
//   </ul>
//
// GRID is the caller's: `grid items-center gap-x-6 px-5 grid-cols-[…]`, one
// constant per table, stepping columns away with `@max-[NNrem]/table:` queries
// against the table's own width.
//
// The rule that makes it read as designed: what repeats identically down a
// column recedes (muted ink, no icon); only what differs from the norm gets
// ink, weight or colour.

/** The frame: one glass panel, rows inside. A query container named `table`. */
export const TABLE =
  '@container/table m-0 list-none overflow-hidden rounded-2xl border border-hairline bg-surface p-0 shadow-[inset_0_1px_0_var(--hairline-hi),var(--board-shadow)]'

/** The labels row: a faint band, small muted labels. */
export const TABLE_HEAD =
  'h-[2.125rem] border-hairline border-b bg-foreground/[0.02] text-[0.72rem] text-muted-foreground [font-weight:500]'

/** A row. Hairline above every row except the first after the head or a group. */
export const TABLE_ROW =
  'group/row relative min-h-[3.25rem] border-hairline border-t py-2 text-[0.8125rem] transition-colors duration-100 [&:nth-child(2)]:border-t-0 [[data-group]+&]:border-t-0 first:border-t-0'

/** A row that is a link (stretch an anchor inside with TABLE_LINK). */
export const TABLE_ROW_LINK =
  'hover:bg-foreground/[0.025] has-[a:focus-visible]:bg-foreground/[0.04] has-[a:focus-visible]:shadow-[inset_0_0_0_2px_var(--brand-dim)]'

/** An anchor whose hit area is its whole row (the row must be `relative`). */
export const TABLE_LINK =
  'text-inherit no-underline outline-none after:absolute after:inset-0 hover:no-underline'

/** The first cell's name: the one primary-ink text in a row. */
export const CELL_NAME = 'truncate text-[0.875rem] text-foreground [font-weight:560]'
/** A second line under the name. */
export const CELL_SUB = 'm-0 truncate text-[0.78rem] text-muted-foreground/85'
/** A quiet value: a time, a count, a repeated word. */
export const CELL_QUIET = 'text-[0.78rem] text-muted-foreground tabular-nums'
/** An identifier: host, digest, path. */
export const CELL_MONO = 'min-w-0 truncate font-mono text-[0.72rem] text-muted-foreground'

/** An empty table says so in one row. */
export const TABLE_EMPTY = 'px-5 py-12 text-center text-[0.85rem] text-muted-foreground'

/** A group inside a table: a quiet band with a name and a note, no head of its own. */
export function TableGroup({
  title,
  note,
  className,
}: {
  title: string
  note?: string
  className?: string
}) {
  return (
    <li
      data-group=""
      className={cn(
        'flex h-8 items-center gap-2.5 border-hairline border-y bg-foreground/[0.02] px-5 text-[0.75rem] first:border-t-0',
        className,
      )}
    >
      <span className="text-foreground [font-weight:560]">{title}</span>
      {note !== undefined && <span className="text-muted-foreground">{note}</span>}
    </li>
  )
}

/** A heading above a table or a group of boards: one pattern for the whole app. */
export const SECTION_TITLE =
  'mt-10 mb-3 flex flex-wrap items-center gap-x-2 text-[0.875rem] text-foreground [font-weight:600] first:mt-0'
/** The line under a SECTION_TITLE. */
export const SECTION_NOTE = '-mt-2 mb-3 text-[0.8rem] text-muted-foreground'
