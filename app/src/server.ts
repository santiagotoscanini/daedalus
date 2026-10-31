import handler, { createServerEntry } from '@tanstack/react-start/server-entry'
import { withSecurityHeaders } from './core/security-headers'

// The server entry: what a build emits as `dist/server/server.js`. The default
// export is TanStack Start's own fetch handler with the security headers on
// what it answers (core/security-headers.ts); the named exports
// are for server.mjs, which starts the process's background work once it
// listens and stops it, and the pool, when it is told to stop. Dev mode loads
// host/background.ts itself (vite.config.ts) and uses only the default export.

export default createServerEntry({
  fetch: async (...args: Parameters<typeof handler.fetch>) =>
    withSecurityHeaders(await handler.fetch(...args)),
})

export { start as startBackground, stop as stopBackground } from './host/background'
export { closeDb } from './lib/repo/pool'
