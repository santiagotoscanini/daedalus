// The board vocabulary, spelled once for every category page.
//
// These nine strings were the last of styles.css's `.note`, `.foot`, `.mono`
// and friends, and each category file restated them while the legacy sheet was
// being retired — deliberately, so that a half-migrated file had nothing to
// keep in step with. That migration is finished (styles.css is element
// defaults and keyframes now), and what the restating left behind is what it
// was always going to leave behind: forty-six declarations of nine strings,
// drifting. `text-(--dim)` here, `text-muted-foreground` there;
// `[overflow-wrap:anywhere]` on one page and `wrap-anywhere` on the next; an
// `m-0` that only some of them carried. Every one of those pairs is the same
// rendered pixel — `--dim` IS `--muted-foreground` (theme.css) and
// `wrap-anywhere` IS `overflow-wrap: anywhere` — which is the tell: nothing
// was choosing between them, they were just being retyped.
//
// A caption set at 0.73rem on one tab and 0.75rem on the next reads as a
// rendering fault and no diff would show it. That is the whole argument for
// one module.
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
