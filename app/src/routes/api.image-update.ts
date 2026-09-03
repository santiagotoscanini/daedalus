import { createFileRoute } from '@tanstack/react-router'
// Type-only, so it is erased rather than pulling the bridge's node:fs into a
// bundle — the value import below stays dynamic like every other server reach.
import type { ImageTarget } from '../lib/image-update'

// Move a container's image pin without the UI, and read back where it got to.
//
// Same code path as the Update button — both are adapters over
// lib/update-flow.ts's runImageUpdate — so this is the scriptable door onto
// exactly the mechanism a person drives from the Updates page, not a second
// one that could drift from it. Useful for testing the host agent, and for
// the eventual "take patch updates on a schedule" without anything having to
// drive a browser.
//
//   GET  /api/image-update                       → the current status
//   POST /api/image-update  {container, toTag}   → move one
//   POST /api/image-update  {targets:[{container, toTag}]} → move several
//
// `toTag` is optional: omitted means "re-resolve the tag this container is
// already on", which is the whole update for a channel pin like `:latest`.
//
// The single form is the original and still works; it is normalised into a
// one-element `targets` here so both shapes reach the same flow. Several
// targets become ONE commit, ONE build and ONE switch — and, if any of them
// fails, ONE revert that takes the others with it.
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

        let body: { container?: unknown; toTag?: unknown; targets?: unknown } = {}
        try {
          body = (await request.json()) as typeof body
        } catch {
          return Response.json({ status: 'refused', reason: 'body is not JSON' }, { status: 400 })
        }

        // Both shapes, one parser. `targets` wins when present so a caller
        // sending both cannot mean two different things at once.
        const raw: unknown[] =
          body.targets === undefined ? [{ container: body.container, toTag: body.toTag }] : []

        if (body.targets !== undefined && !Array.isArray(body.targets)) {
          return Response.json(
            { status: 'refused', reason: 'targets must be an array when present' },
            { status: 400 },
          )
        }

        const list = (Array.isArray(body.targets) ? body.targets : raw) as {
          container?: unknown
          toTag?: unknown
        }[]

        const targets: ImageTarget[] = []
        for (const t of list) {
          if (typeof t?.container !== 'string') {
            return Response.json(
              { status: 'refused', reason: 'container must be a string' },
              { status: 400 },
            )
          }
          if (t.toTag !== undefined && typeof t.toTag !== 'string') {
            return Response.json(
              { status: 'refused', reason: 'toTag must be a string when present' },
              { status: 400 },
            )
          }
          targets.push({
            container: t.container,
            ...(t.toTag === undefined ? {} : { toTag: t.toTag }),
          })
        }

        const outcome = await runImageUpdate({
          targets,
          actor: request.headers.get('x-forwarded-email') ?? 'api',
        })

        if (!outcome.ok) {
          return Response.json({ status: outcome.code, reason: outcome.reason }, { status: 409 })
        }
        // The pre-batch response shape, for a one-container request only.
        // Reporting the first of six as "the" container would be worse than
        // omitting it.
        const only = outcome.targets.length === 1 ? outcome.targets[0] : undefined

        return Response.json({
          status: 'queued',
          id: outcome.id,
          targets: outcome.targets,
          ...(only === undefined ? {} : { container: only.container, toTag: only.toTag }),
        })
      },
    },
  },
})
