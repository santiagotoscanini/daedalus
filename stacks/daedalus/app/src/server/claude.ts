import { createServerFn } from '@tanstack/react-start'

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
