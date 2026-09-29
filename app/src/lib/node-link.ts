import { since } from './format'

// A machine's link, as every page words it. `connected` is null while the
// controller cannot be asked (lib/repo/nodes.ts): the box cannot see the
// machine, which says nothing about the machine, so no page may turn that into
// "not connected".

/** The words for a link nobody can currently vouch for. */
export const LINK_UNKNOWN = 'unknown while the controller is unreachable'

export function linkWords(n: { connected: boolean | null; lastSeenAgo: number }): string {
  if (n.connected === null) return LINK_UNKNOWN
  return n.connected ? 'connected' : `not connected · last heard ${since(n.lastSeenAgo)}`
}
