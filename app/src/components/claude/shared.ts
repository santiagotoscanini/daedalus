// What more than one of the Claude page's files spells the same way: the
// narrow-width hide. The arming window and the look of the controls at the
// foot of a board are every page's (components/armed-confirm.tsx).

/* A detail that earns its place on a wide row and not on a narrow one. Every
   side slot truncates, so a row of seven on a phone technically fits — as a
   chip, a clipped name and five ellipses, which is width spent to say nothing.
   Dropping the least important outright gives the rest room to be read. */
export const NARROW_HIDE = 'max-[50rem]:hidden'

/* Key/value rows in a board wider than a third of the page: the value sits on
   a fixed label column, left-aligned, instead of being pushed to the far edge
   where the eye has to cross the whole board to pair it with its label. A
   wrapper over `Facts list`, which right-aligns for the narrow boards. */
// Below ~30rem of board a label column does not fit, so label stacks over value.
export const LEFT_FACTS =
  '[&_dl>div]:justify-start [&_dl>div]:flex-nowrap [&_dt]:w-[12.5rem] [&_dd]:min-w-0 [&_dd]:text-left [&_dd]:[overflow-wrap:anywhere] @max-[30rem]/board:[&_dl>div]:flex-col @max-[30rem]/board:[&_dl>div]:items-start @max-[30rem]/board:[&_dl>div]:gap-0.5 @max-[30rem]/board:[&_dt]:w-auto'
