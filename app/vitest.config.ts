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
  },
})
