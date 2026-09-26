// The board vocabulary, spelled once for every category page.
//
// A caption set at 0.73rem on one tab and 0.75rem on the next reads as a
// rendering fault and no diff would show it. That is the whole argument for
// one module: reuse these rather than retyping a near-copy.
//
// What is NOT here, because it genuinely looks different: Settings' own note
// and mono (a larger 0.78rem/0.8rem at `--text-muted`, which is a darker ink
// than `--muted-foreground` in the light theme), and the image-update card's
// 0.76rem note. They stay beside the pages that want them.

/** The small grey reading in a board's header. */
export const NOTE = 'text-[0.73rem] text-muted-foreground'

/** A heading inside a board's body, between two groups of content. */
export const SUB =
  'mt-[0.35rem] -mb-[0.2rem] text-[0.73rem] font-[550] tracking-normal text-muted-foreground'

/** A board header that carries a live dot beside its reading. */
export const LIVE =
  'inline-flex items-center gap-[0.35rem] text-[0.73rem] whitespace-nowrap text-(--text-muted)'

/**
 * The caption under a board's content, without its ink.
 *
 * Split from `FOOT` so a coloured variant states its own colour rather than
 * layering a second text utility over the first — between two `text-*`
 * utilities the winner is decided by source order in the emitted stylesheet,
 * not by the order they appear in the string.
 */
export const FOOT_BASE = 'm-0 mt-[0.15rem] text-[0.73rem] leading-[1.45] [overflow-wrap:anywhere]'

/** The caption under a board's content: what the numbers above it mean. */
export const FOOT = `${FOOT_BASE} text-muted-foreground`

/** "There is nothing to draw here", said out loud. */
export const EMPTY =
  'm-0 py-[0.9rem] text-center text-[0.8rem] text-muted-foreground [overflow-wrap:anywhere]'

/**
 * Monospace without a size, for slots whose own rule sets one — putting both
 * here would emit two `text-*` utilities and leave the winner to the layer.
 */
export const MONO_FACE = 'font-mono [overflow-wrap:anywhere]'

/**
 * An identifier: a hostname, an address, a digest. No spaces to break at, so
 * it is allowed to break anywhere.
 *
 * The size is an `em` on purpose — a monospace face at the size of the sans
 * text around it reads a step larger, so every one of these shrinks against
 * whatever it sits in. A row that sets its own size overrides it.
 */
export const MONO = `${MONO_FACE} text-[0.86em]`

/** The two dates under a column chart, and what is being counted. */
export const AXIS =
  'm-0 -mt-[0.35rem] flex justify-between gap-[0.6rem] text-[0.66rem] text-muted-foreground tabular-nums'

/* A flat list of named things: rows of a table, not a stack of pills. The
   hairline is on every row and removed from the first. Read by the System
   tabs, the Claude page and several module views. */
export const LIST = 'flex flex-col'
export const ROW =
  'flex min-w-0 items-center gap-[0.45rem] border-(--border-soft) border-t px-[0.1rem] py-[0.34rem] text-[0.77rem] first:border-t-0'
/** The name takes the slack, so the detail is pushed right without a spacer. */
export const ROW_MAIN = 'min-w-0 flex-auto truncate text-foreground'
export const ROW_SIDE =
  'min-w-0 max-w-[60%] flex-initial truncate text-[0.68rem] text-muted-foreground tabular-nums'
export const ROW_N = 'min-w-[1.4rem] text-right text-foreground tabular-nums'
