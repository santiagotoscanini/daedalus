import { defineConfig } from 'vitest/config'

// Deliberately NOT vite.config.ts: that config exists to run the app (TanStack
// Start plugin, HMR-over-traefik, allowedHosts) and none of it belongs under a
// test runner. Tests here are node-side table tests over pure modules; vitest
// only needs Vite's resolver so the codebase's extensionless relative imports
// keep working.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Some tested modules import lib/db, which builds its client at import time
    // from DATABASE_URL (lib/env refuses a missing one). postgres-js does not
    // connect until the first query, so an address nothing listens on satisfies
    // the import — on a CI runner with no database, and in the dev container,
    // where it also turns an accidental query into a loud connection refusal
    // instead of a read or write against the box's real database.
    env: { DATABASE_URL: 'postgres://vitest@127.0.0.1:1/vitest' },
  },
})
