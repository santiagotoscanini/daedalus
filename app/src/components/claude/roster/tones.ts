// How each roster population reads: its chip's tone and word, and the name of
// its group on the board (rows are grouped by state, so the group says it once).
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

/** The board's group band for each population: its name, and what it means. */
export const STATE_GROUP: Record<SessionState, { title: string; note: string }> = {
  alive: { title: 'Connected', note: 'a process is running it' },
  background: { title: 'Background', note: 'background agents with a process behind them' },
  orphan: { title: 'No transcript', note: 'running, with no transcript in the scanned tree' },
  dormant: { title: 'Dormant', note: 'a background record with no process; the CLI still owns it' },
  resumable: { title: 'Resumable', note: 'on disk, nothing running it' },
}
