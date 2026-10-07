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
