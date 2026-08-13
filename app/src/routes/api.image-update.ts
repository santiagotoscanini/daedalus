import { createFileRoute } from '@tanstack/react-router'

// Move a container's image pin without the UI, and read back where it got to.
//
// Same code path as the Update button — both are adapters over
// lib/update-flow.ts's runImageUpdate — so this is the scriptable door onto
// exactly the mechanism a person drives from the Updates page, not a second
// one that could drift from it. Useful for testing the host agent, and for
// the eventual "take patch updates on a schedule" without anything having to
// drive a browser.
//
//   GET  /api/image-update                     → the current status
//   POST /api/image-update  {container, toTag} → queue one
//
// `toTag` is optional: omitted means "re-resolve the tag this container is
// already on", which is the whole update for a channel pin like `:latest`.
//
// Behind the forward-auth gate like everything except /api/healthz and
// /api/deploy, so a request reaching this from outside has passed Pocket ID.
export const Route = createFileRoute('/api/image-update')({
  server: {
    handlers: {
      GET: async () => {
        const { readImageUpdateStatus } = await import('../lib/image-update')
        return Response.json(await readImageUpdateStatus())
      },

      POST: async ({ request }) => {
        const { runImageUpdate } = await import('../lib/update-flow')

        let body: { container?: unknown; toTag?: unknown } = {}
        try {
          body = (await request.json()) as typeof body
        } catch {
          return Response.json({ status: 'refused', reason: 'body is not JSON' }, { status: 400 })
        }

        if (typeof body.container !== 'string') {
          return Response.json(
            { status: 'refused', reason: 'container must be a string' },
            { status: 400 },
          )
        }
        if (body.toTag !== undefined && typeof body.toTag !== 'string') {
          return Response.json(
            { status: 'refused', reason: 'toTag must be a string when present' },
            { status: 400 },
          )
        }

        const outcome = await runImageUpdate({
          container: body.container,
          ...(body.toTag === undefined ? {} : { toTag: body.toTag }),
          actor: request.headers.get('x-forwarded-email') ?? 'api',
        })

        if (!outcome.ok) {
          return Response.json({ status: outcome.code, reason: outcome.reason }, { status: 409 })
        }
        return Response.json({
          status: 'queued',
          id: outcome.id,
          container: outcome.container,
          toTag: outcome.toTag,
        })
      },
    },
  },
})
