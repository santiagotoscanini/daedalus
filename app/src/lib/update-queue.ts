import { isRecord } from './is-record'

// The update queue, as data: the pins someone chose to move together, kept on
// the server so the Updates tab and the MCP tools are looking at one list.
//
// A queue is a selection, not a commitment: nothing is asked of the host until
// it is run, and it runs as ONE request, one commit, one build, one switch.

/** One queued pin: what its row had decided when it was added. */
export type QueueItem = {
  container: string
  /** Null = re-pull the tag it is on, the channel-pin case. */
  toTag: string | null
  tag: string
  lockstep: string[]
  ceremony: string | null
  /** The ceremony's typed confirmation, which the batch is run with. */
  typed: string
}

const isItem = (v: unknown): v is QueueItem =>
  isRecord(v) &&
  typeof v.container === 'string' &&
  (v.toTag === null || typeof v.toTag === 'string') &&
  typeof v.tag === 'string' &&
  Array.isArray(v.lockstep) &&
  v.lockstep.every((m) => typeof m === 'string') &&
  (v.ceremony === null || typeof v.ceremony === 'string') &&
  typeof v.typed === 'string'

export const isQueue = (v: unknown): v is QueueItem[] => Array.isArray(v) && v.every(isItem)

/** The queue with this pin in it, replacing any earlier entry for the same pin. */
export const withItem = (queue: readonly QueueItem[], item: QueueItem): QueueItem[] => [
  ...queue.filter((q) => q.container !== item.container),
  item,
]

/** The queue without this pin. */
export const withoutItem = (queue: readonly QueueItem[], container: string): QueueItem[] =>
  queue.filter((q) => q.container !== container)

/**
 * The queued pin that already moves this one, if any. A lockstep member is
 * covered by its primary, and the host refuses the pair.
 */
export function coveredBy(queue: readonly QueueItem[], container: string): string | null {
  return queue.find((q) => q.lockstep.includes(container))?.container ?? null
}
