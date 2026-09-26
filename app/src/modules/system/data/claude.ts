import { type ClaudeData, loadClaude } from '../../../lib/dashboard/claude'

// The Claude and Shotter tabs read one document: the remote-control
// snapshot, its Loki history and the Playwright pin. One loader for both
// tabs — splitting it would spend a second round of the same upstreams for a
// tab whose data is already in hand.
export type { ClaudeData }
export { loadClaude }
