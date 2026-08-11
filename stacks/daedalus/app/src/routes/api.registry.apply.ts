import { createFileRoute } from '@tanstack/react-router'

// Trigger an apply without the UI, and read back where it got to.
//
// Same code path as the Apply button — both are adapters over
// lib/apply-flow.ts's runApply, so there is exactly one implementation and
// this is the scriptable door onto it. Useful for testing the host agent and
// for a future "apply on a schedule" without anything having to drive a
// browser.
//
// Behind the forward-auth gate like everything except /api/healthz and
// /api/deploy, so a request that reaches this from outside has passed Pocket ID.
export const Route = createFileRoute('/api/registry/apply')({
  server: {
    handlers: {
      GET: async () => {
        const { readApplyStatus } = await import('../lib/apply')
        return Response.json(await readApplyStatus())
      },

      POST: async ({ request }) => {
        const { runApply } = await import('../lib/apply-flow')
        const outcome = await runApply(request.headers.get('x-forwarded-email') ?? 'api')
        if (!outcome.ok) {
          return Response.json({ status: outcome.code, reason: outcome.reason }, { status: 409 })
        }
        return Response.json({ status: 'queued', id: outcome.id, changed: outcome.changed })
      },
    },
  },
})
