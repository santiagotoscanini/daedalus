/* ── shared ───────────────────────────────────────────────────────────── */

/** Four-segment tags: the *arrs number their builds — see `cmp` in github.ts. */
export const ARR_TAG = /^v?(\d+\.\d+\.\d+\.\d+)$/

/** The window the Cleanup tab and Recyclarr's panel count log lines over. */
export const CLEANUP_DAYS = 7

/**
 * Whole days between a timestamp and now.
 *
 * Computed on the server, deliberately: these components
 * stream and then hydrate, and a relative time derived from the browser's clock
 * renders differently from the one the server sent whenever the two straddle a
 * day boundary. React reports that as a hydration mismatch.
 */
export function daysSince(stamp: string | undefined, now: number): number | null {
  if (stamp === undefined || stamp === '') return null
  const t = Date.parse(stamp)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now - t) / 86_400_000))
}
