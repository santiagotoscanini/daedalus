import { createFileRoute } from '@tanstack/react-router'

// The gateway sync's door: GET the last summary, POST to run one now.
//
// Behind the forward-auth gate like everything except /api/healthz and
// /api/deploy; the POST is an admin action under the `admins` check like
// the other doors that change something.
export const Route = createFileRoute('/api/gateway/sync')({
  server: {
    handlers: {
      GET: async () => {
        const { lastGatewaySync } = await import('../host/gateway-sync')
        return Response.json(lastGatewaySync())
      },
      POST: async ({ request }) => {
        const { assertAdminOf } = await import('../core/authz')
        await assertAdminOf(request)
        const { makeCtx } = await import('../core/ctx')
        const { syncGateway } = await import('../host/gateway-sync')
        return Response.json(await syncGateway(await makeCtx()))
      },
    },
  },
})
