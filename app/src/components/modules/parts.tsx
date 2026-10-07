// What the service tabs (Home, Health, Gaming) draw lists and states with.
//
// A list is a free-standing TABLE under an out-of-card heading
// (`TableSection`), never a table inside a titled board. These are the few
// things those tables share beyond components/table.tsx.

import type { ReactNode } from 'react'

/**
 * A `TableSection`'s width on the 12-wide board grid, stepping the way a
 * `Board`'s span does (doubled on a laptop, full on a phone), so a section and
 * a board in one row wrap together.
 */
export const SECTION_SPAN = {
  4: 'mt-4 col-span-4 max-[78rem]:col-span-8 max-[50rem]:col-span-12',
  6: 'mt-4 col-span-6 max-[78rem]:col-span-12',
  8: 'mt-4 col-span-8 max-[78rem]:col-span-12',
  12: 'mt-4 col-span-12',
} as const

/** A numeric column: right-aligned, tabular, never broken. Header and cell both wear it. */
export const NUM_CELL = 'text-right tabular-nums whitespace-nowrap'

/** One muted sentence where a table would be empty: no header row over nothing. */
export const TABLE_NONE = 'm-0 py-1 text-[0.84rem] text-muted-foreground'

/**
 * A state that is the norm, said quietly: a muted word, no dot and no colour.
 * The exception (down, stopped, behind) is a `Chip` in its tone instead — the
 * one thing on the line that should catch the eye.
 */
export function QuietState({ children }: { children: ReactNode }) {
  return <span className="text-[0.78rem] whitespace-nowrap text-muted-foreground">{children}</span>
}

/**
 * Label and value rows for a board wider than a third: values left-aligned on
 * a fixed label column, hairlines between. Below ~34rem of board width the
 * label stacks above its value, so a path or a sentence gets the whole line
 * instead of a right-aligned sliver beside its label.
 */
export function KeyValue({ rows }: { rows: { k: string; v: ReactNode }[] }) {
  return (
    <dl className="m-0">
      {rows.map((r) => (
        <div
          key={r.k}
          className="grid grid-cols-[11rem_minmax(0,1fr)] items-baseline gap-x-6 gap-y-0.5 border-hairline border-t py-2.5 first:border-t-0 first:pt-0 @max-[34rem]/board:grid-cols-1"
        >
          <dt className="text-[0.82rem] text-muted-foreground">{r.k}</dt>
          <dd className="m-0 min-w-0 text-[0.84rem] [overflow-wrap:anywhere]">{r.v}</dd>
        </div>
      ))}
    </dl>
  )
}
