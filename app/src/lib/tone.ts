/**
 * The six verdicts this dashboard can render, and the one way they become
 * colour.
 *
 * Every visual primitive on a category page — the big number, the ring, the
 * bar list, the column chart, the trend line, the progress bar, the pulse
 * dot — carries a tone, and all seven used to resolve it through a class per
 * family per tone: forty-two rules setting seven differently-named custom
 * properties to the same six colours. This is that table, once.
 *
 * The mechanism is a CSS variable rather than a colour utility because a
 * primitive tints several things at once — a fill, a track, a glow, a
 * label — and they must move together. A component sets `--tone` on its root
 * with `toneStyle(tone)` and its parts read it with `bg-(--tone)`,
 * `text-(--tone)`, `border-(--tone)`. One assignment, any number of
 * consumers, and no utility permutation to enumerate.
 *
 * `muted` is not a colour a thing IS, it is the absence of a verdict — a
 * reading with nothing to say about it. `info` is the fourth status colour
 * for a fact that is neither good nor bad: a count, a rate, a share.
 */

import type { CSSProperties } from 'react'

export type Tone = 'accent' | 'ok' | 'warn' | 'bad' | 'info' | 'muted'

const TONE_TOKEN: Record<Tone, string> = {
  accent: 'var(--primary)',
  ok: 'var(--success)',
  warn: 'var(--warning)',
  bad: 'var(--danger)',
  info: 'var(--info)',
  muted: 'var(--dim)',
}

/**
 * The inline style that arms `--tone` on a primitive's root.
 *
 * Inline rather than a class, and it has to be: a class would have to be one
 * of six literal strings for Tailwind's scanner to emit it, which is exactly
 * the forty-two-rule table this replaces.
 */
export function toneStyle(tone: Tone, extra?: CSSProperties): CSSProperties {
  return { ...extra, ['--tone' as string]: TONE_TOKEN[tone] }
}
