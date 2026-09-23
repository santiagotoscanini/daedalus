import { type ClaudeData, loadClaude } from '../../../lib/dashboard/claude'

// The Claude and Shotter tabs read the one document the Claude page read:
// the remote-control snapshot, its Loki history and the Playwright pin. One
// loader for both tabs, as it was one fetch for both when they were a page
// of their own — splitting it would spend a second round of the same
// upstreams for a tab whose data is already in hand.
export type { ClaudeData }
export { loadClaude }
