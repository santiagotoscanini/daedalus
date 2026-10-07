// What the service tabs (Home, Health, Gaming) draw lists and states with.
//
// A list inside a board is a TABLE with the board as its frame: the head band
// and the row rules run edge to edge across the board (the `-mx-5` undoes the
// board body's padding), the cells keep the board's 20px inset, and the column
// grid is the caller's, one constant per table, shared by head and rows —
// exactly as components/table.tsx lays out a free-standing one. Being inside a
// Board keeps what a board gives: a title, an aside, and the ⓘ that folds the
// explanation under the list.

import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import { type Tone, toneStyle } from '../../lib/tone'
import { TABLE_HEAD, TABLE_ROW } from '../table'

/** The list element: a query container named `table`, flush with the board's edges. */
export const BOARD_TABLE = '@container/table -mx-5 my-0 list-none p-0'

/** The labels row. A rule above it as well as below: it starts the table under the title. */
export const BOARD_TABLE_HEAD = cn(TABLE_HEAD, 'border-t')

/** A row. The house table's row, so 52px and a hairline between. */
export const BOARD_TABLE_ROW = TABLE_ROW

/** The last row's bottom rule, for a table followed by more of the board. */
export const BOARD_TABLE_END = 'border-hairline border-b'

/** A numeric column: right-aligned, tabular. Header and cell both wear it. */
export const NUM_CELL = 'text-right tabular-nums'

/**
 * A state that is the norm, said quietly: a small static dot and a muted word.
 * The exception (down, stopped) is a `Chip` in its tone instead — that is the
 * one that should catch the eye.
 */
export function QuietState({ tone = 'ok', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[0.78rem] whitespace-nowrap text-muted-foreground"
      style={toneStyle(tone)}
    >
      <span className="size-1.5 flex-none rounded-full bg-(--tone)" aria-hidden="true" />
      {children}
    </span>
  )
}
