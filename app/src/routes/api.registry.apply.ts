import { createFileRoute } from '@tanstack/react-router'
import { actorLabelOf } from '../core/auth'
import { httpResult } from '../lib/http-result'

// Trigger an apply without the UI, and read back where it got to.
//
// Same code path as the Apply button — both are adapters over
// host/apply-flow.ts's runApply, so there is exactly one implementation and
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
        const { readApplyStatus } = await import('../host/apply')
        return Response.json(await readApplyStatus())
      },

      POST: async ({ request }) => {
        const { assertAdminOf } = await import('../core/authz')
        await assertAdminOf(request)
        const { runApply } = await import('../host/apply-flow')
        const { flowResult } = await import('../host/flow')
        const outcome = await runApply(actorLabelOf(request, 'api'))
        // Every refusal an Apply has — busy, nothing to apply — is about the
        // state of the box, never about the request, which has no body.
        return httpResult(flowResult(outcome), { kind: () => 'conflict' })
      },
    },
  },
})
