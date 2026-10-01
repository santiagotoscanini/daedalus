import type { SystemData } from '../data'
import { BoardView as MachineBoardView } from './node/board'

/* ── Motherboard ──────────────────────────────────────────────────────── */

type Board = Extract<SystemData, { tab: 'board' }>

/** The box's Motherboard tab: the same view a node's draws, over the host snapshot. */
export function BoardView({ d }: { d: Board }) {
  return <MachineBoardView info={d} />
}
