// How each roster population reads: its chip's tone and word, and whether it
// earns the coloured stripe down the row's left edge.
import type { SessionState } from '../../../lib/claude-roster'
import type { Tone } from '../../../lib/tone'

export const STATE_TONE: Record<SessionState, Tone> = {
  alive: 'ok',
  background: 'info',
  // Not `info`, and not `warn` either: a dormant record is neither running nor
  // broken. It is a leftover, and it should read as quietly as the resumable
  // tail rather than borrowing the colour of the two live populations.
  dormant: 'muted',
  orphan: 'warn',
  resumable: 'muted',
}

export const STATE_LABEL: Record<SessionState, string> = {
  alive: 'alive',
  background: 'background',
  dormant: 'dormant',
  orphan: 'no transcript',
  resumable: 'resumable',
}

/* The five states have to stay apart, and three lines per row is exactly the
   pressure that would blur them — a page of equally tall blocks reads as one
   population. The chip still carries the verdict; this is a second, quieter
   index down the left edge, so a running session can be found by colour from
   the top of a list of twenty-four.

   Every row carries the border and the padding, so the text edge never moves;
   the two quiet populations simply make theirs transparent. That is the whole
   reason this is not a conditional wrapper. */
export const ROW_ACCENT = 'border-l-2 pl-[0.5rem]'
export const STATE_ACCENT: Record<SessionState, string> = {
  alive: 'border-l-(--tone)',
  background: 'border-l-(--tone)',
  orphan: 'border-l-(--tone)',
  // A leftover and a dead conversation on disk are not states worth a stripe.
  // They are the resting mass of this board, and the three above have to be
  // findable against them.
  dormant: 'border-l-transparent',
  resumable: 'border-l-transparent',
}
