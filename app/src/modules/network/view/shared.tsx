import type { Tone } from '../../../components/viz'

/* ── shared ───────────────────────────────────────────────────────────── */

/**
 * A tri-state health as a dot tone.
 *
 * `null` is "could not be read", which is grey — deliberately not the same
 * claim as down, and the state a route lands in when the thing that would
 * answer for it is itself unreachable.
 */
export function tone(ok: boolean | null): Tone | null {
  return ok === null ? null : ok ? 'ok' : 'bad'
}

/* ── the vocabulary the six tabs share ─────────────────────────────────────
   The board vocabulary every category page uses lives in components/tokens.ts;
   it is re-exported here so a tab imports only its own page's shared file.
   Below is what is genuinely Network's. */
export { AXIS, CAPTION, EMPTY, FOOT, LIVE, MONO, NOTE, SUB } from '../../../components/tokens'

/* Rows of a table, not a stack of pills: a hairline between rows says what a
   filled capsule per fact said, at a fraction of the ink. */

/** The list. */
export const ROWS = 'm-0 flex list-none flex-col p-0'

/** One row of it. */
export const ROW =
  'flex min-w-0 items-center gap-2 px-0.5 py-2 text-[0.8rem] not-first:border-t not-first:border-hairline'

/** The name in a row. Takes the slack, so the detail is pushed right. */
export const MAIN = 'min-w-0 flex-auto truncate text-foreground'

/** The detail at the end of a row. Truncates: a record's content is 200
    characters of base64 nobody reads on a dashboard. */
export const SIDE =
  'min-w-0 max-w-[60%] flex-initial truncate text-[0.72rem] text-muted-foreground tabular-nums'

/** The count at the end of a row. */
export const N = 'min-w-[1.4rem] text-right text-foreground tabular-nums'

/** A folded group: the disclosure triangle, and the summary it sits in. Size
    and colour are left to the caller — a fold inside a board and the fold that
    ends a ranked list are the same mechanism at two weights. */
const FOLD =
  "[&>summary]:flex [&>summary]:cursor-pointer [&>summary]:list-none [&>summary]:items-center [&>summary]:gap-2 [&>summary]:px-0.5 [&>summary]:py-1.5 [&>summary]:transition-colors [&>summary]:hover:text-foreground [&>summary::-webkit-details-marker]:hidden [&>summary]:before:text-[0.7rem] [&>summary]:before:text-muted-foreground [&>summary]:before:transition-transform [&>summary]:before:duration-[0.12s] [&>summary]:before:ease-[ease] [&>summary]:before:content-['▸'] [&[open]>summary]:before:rotate-90"

/** The tail of a list, folded. Set apart from the rows above it so the fold
    reads as the end of the list rather than as another row in it. */
export const MORE = `${FOLD} mt-1.5 border-t border-hairline pt-1 [&>summary]:text-[0.75rem] [&>summary]:text-muted-foreground`

/** A folded group inside a board. */
export const GROUP = `${FOLD} [&>summary]:text-[0.8rem] [&>summary]:text-foreground`

/** The bar that carries a tab's route/tunnel switch: a toolbar, so it sits
    where every toolbar does — left, under the tabs, above what it switches —
    with no rule of its own. */
export const SWITCH_BAR = 'mx-0 mt-0 mb-6 flex flex-wrap items-center gap-3'
