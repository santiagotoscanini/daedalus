import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'

// The Claude page's one loader.
//
// Thin on purpose, like its siblings here: the work is in
// lib/dashboard/claude.ts, and this exists so the browser bundle never gets
// near the snapshot reader (node:fs) or the Loki client.
//
// One function rather than the boards/dots pair the category pages use. That
// split buys a tab row that renders before its slowest upstream; this page
// has no tabs, and its three sources are a file read, one anchored LogQL
// query and a cached GitHub list — all of which the streaming skeleton
// already covers.

export const fetchClaude = createServerFn().handler(async () => {
  const { loadClaude } = await import('../lib/dashboard/claude')
  return loadClaude()
})

/**
 * Ask the host to restart the Remote Control server.
 *
 * Returns as soon as the request file is written; the caller polls the
 * status for its own id. Terminal states are real here (host/claude-rc.sh
 * outlives its action), so no healthz dance — done or failed arrives within
 * ~ten seconds.
 */
export const requestClaudeRestartFn = createServerFn({ method: 'POST' }).handler(async () => {
  const { requestClaudeRcRestart } = await import('../lib/claude-rc-request')
  // The forward-auth middleware forwards the Pocket ID claim, so the request
  // records a person rather than "daedalus".
  const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
  return { id: await requestClaudeRcRestart({ actor }) }
})

export const fetchClaudeRcStatusFn = createServerFn().handler(async () => {
  const { readClaudeRcStatus } = await import('../lib/claude-rc-request')
  return readClaudeRcStatus()
})
