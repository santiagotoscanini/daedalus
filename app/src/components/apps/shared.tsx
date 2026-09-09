import type { fetchApp } from '../../server/registry'

export type LoaderData = Awaited<ReturnType<typeof fetchApp>>
export type AppRecord = NonNullable<LoaderData>['app']

/* The three prose faces every tab body on this page uses. Spelled once here
   rather than repeated across ten files, the way lib/tone.ts spells the
   tone utilities: they are one decision, and a copy that drifts is a tab
   whose captions are a different grey from its neighbour's.

   Whole literal strings, so Tailwind's scanner still sees every utility. */

/** The sentence under a heading, or in place of a panel the app cannot fill. */
export const LEDE = 'mt-[0.3rem] mb-0 max-w-[74ch] text-[0.9rem] text-(--text-muted)'

/** The caption inside a board, under whatever it explains. */
export const BOARD_FOOT =
  'mt-[0.15rem] mb-0 text-[0.73rem] leading-[1.45] text-(--dim) [overflow-wrap:anywhere]'

/** The one line of prose a stat strip is allowed, directly under the numbers. */
export const STRIP_FOOT =
  'mt-[-0.35rem] mb-[1.4rem] max-w-[74ch] text-[0.73rem] leading-[1.5] text-(--dim)'

/** A board with nothing to show. Centred, so it reads as a state, not a row. */
export const VIZ_EMPTY =
  'm-0 py-[0.9rem] text-center text-[0.8rem] text-(--dim) [overflow-wrap:anywhere]'

/** A rule and a small-caps label, opening a section inside a tab body. */
export const SECTION_HEAD =
  'mt-10 mr-0 mb-[0.85rem] ml-0 flex flex-wrap items-baseline gap-x-[0.7rem] gap-y-[0.3rem] border-t border-t-(--border-soft) pt-[1.4rem] text-[0.7rem] font-semibold tracking-[0.13em] text-(--dim) uppercase'

/** The subtitle beside a section head, back in sentence case. */
export const SECTION_HEAD_SMALL = 'text-[0.76rem] font-normal tracking-normal normal-case'

/** The pill shape `.chip` had: rounder and smaller than shadcn's Badge. */
export const CHIP = 'rounded-full border px-[0.48rem] py-[0.1rem] text-[0.68rem]'

/**
 * The quiet bordered button these pages use for a secondary action:
 * `Button variant="outline"` in the muted ink, so it reads as available but
 * not asked for. Kept as a constant because twenty call sites spell it.
 */
export const GHOST_BTN = 'text-(--text-muted)'
