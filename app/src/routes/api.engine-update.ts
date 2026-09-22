import { createFileRoute } from '@tanstack/react-router'
import { actorLabelOf } from '../core/auth'
import { httpResult } from '../lib/http-result'

// Move the engine's pin without the UI, and read back where it got to.
//
// Same code path as the Update button on System › Updates — both are
// adapters over host/engine-flow.ts's runEngineUpdate — so this is the
// scriptable door onto exactly the mechanism a person drives from the page,
// not a second one that could drift from it. What it is for: testing the
// host agent, and the eventual "take the engine's commits on a schedule"
// without anything having to drive a browser.
//
//   GET  /api/engine-update   → the current status
//   POST /api/engine-update   → fast-forward the clone, move the lock, build,
//                               switch, verify, revert on failure, push
//
// No body. The engine has one input and one branch; there is nothing to
// name. Answers as /api/image-update does: 200 `queued` with the request's
// id, 409 with the flow's code (`busy`, `refused`) and its sentence.
//
// Behind the forward-auth gate like everything except /api/healthz and
// /api/deploy, so a request reaching this from outside has passed Pocket ID.
export const Route = createFileRoute('/api/engine-update')({
  server: {
    handlers: {
      GET: async () => {
        const { readEngineUpdateStatus } = await import('../host/engine-update')
        return Response.json(await readEngineUpdateStatus())
      },

      POST: async ({ request }) => {
        const { assertAdminOf } = await import('../core/authz')
        await assertAdminOf(request)
        const { runEngineUpdate } = await import('../host/engine-flow')
        const { flowResult } = await import('../host/flow')

        const outcome = await runEngineUpdate({ actor: actorLabelOf(request, 'api') })
        return httpResult(flowResult(outcome), { kind: () => 'conflict' })
      },
    },
  },
})
