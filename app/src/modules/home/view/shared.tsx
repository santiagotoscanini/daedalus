import { FOOT_BASE } from '../../../components/tokens'

// What more than one Home tab draws with — Sign-in's included, so the row
// list reads the same on every tab of the page.

/* The one caption on these pages that is not grey. It states its own ink over
   the colourless base rather than layering a second text utility over `FOOT`,
   where source order in the emitted stylesheet — not the order in the string —
   would pick the winner. */
export const FOOT_WARN = `${FOOT_BASE} text-warning`

/* A flat list of named things, each led by a chip saying what kind it is and
   trailed by whatever detail that kind has. Rows of a table, not a stack of
   pills: a hairline between rows says the same thing at a fraction of the ink.
   The row rules hang off the list so the <li>s stay bare. */
export const LIST =
  'flex list-none flex-col [&>li]:flex [&>li]:min-w-0 [&>li]:items-center [&>li]:gap-[0.45rem] [&>li]:px-[0.1rem] [&>li]:py-[0.34rem] [&>li]:text-[0.77rem] [&>li+li]:border-t [&>li+li]:border-(--border-soft)'
/* The name takes the slack, so the detail is pushed right without a spacer.
   Both truncate: one long row must not widen the panel. */
export const MAIN = 'min-w-0 flex-auto truncate text-foreground'
export const SIDE =
  'max-w-[60%] min-w-0 flex-[0_1_auto] truncate text-[0.68rem] tabular-nums text-(--dim)'
export const NUM = 'min-w-[1.4rem] text-right tabular-nums text-foreground'
