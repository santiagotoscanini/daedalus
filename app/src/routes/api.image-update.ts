import { createFileRoute } from '@tanstack/react-router'
import { actorLabelOf } from '../core/auth'
// Type-only, so it is erased rather than pulling the bridge's node:fs into a
// bundle — the value import below stays dynamic like every other server reach.
import type { ImageTarget } from '../host/image-update'
import { httpResult, readJsonObject, refusalResponse } from '../lib/http-result'

// Move a container's image pin without the UI, and read back where it got to.
//
// Same code path as the Update button — both are adapters over
// host/update-flow.ts's runImageUpdate — so this is the scriptable door onto
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
        const { readImageUpdateStatus } = await import('../host/image-update')
        return Response.json(await readImageUpdateStatus())
      },

      POST: async ({ request }) => {
        const { assertAdminOf } = await import('../core/authz')
        await assertAdminOf(request)
        const { runImageUpdate } = await import('../host/update-flow')
        const { flowResult } = await import('../host/flow')

        const badInput = (reason: string) =>
          refusalResponse('bad-input', { code: 'refused', reason })

        const read = await readJsonObject(request)
        if (!read.ok) {
          return badInput(
            read.reason === 'not-json' ? 'body is not JSON' : 'body must be a JSON object',
          )
        }
        const body = read.value

        // Both shapes, one parser. `targets` wins when present so a caller
        // sending both cannot mean two different things at once.
        const raw: unknown[] =
          body.targets === undefined ? [{ container: body.container, toTag: body.toTag }] : []

        if (body.targets !== undefined && !Array.isArray(body.targets)) {
          return badInput('targets must be an array when present')
        }

        const list = (Array.isArray(body.targets) ? body.targets : raw) as {
          container?: unknown
          toTag?: unknown
        }[]

        const targets: ImageTarget[] = []
        for (const t of list) {
          if (typeof t?.container !== 'string') {
            return badInput('container must be a string')
          }
          if (t.toTag !== undefined && typeof t.toTag !== 'string') {
            return badInput('toTag must be a string when present')
          }
          targets.push({
            container: t.container,
            ...(t.toTag === undefined ? {} : { toTag: t.toTag }),
          })
        }

        const outcome = await runImageUpdate({
          targets,
          actor: actorLabelOf(request, 'api'),
        })

        const result = flowResult(outcome)
        // 409 for the flow's `refused` too (no container named, one named
        // twice), though the same word from the body checks above is a 400:
        // that is the status this route has always answered, and callers
        // branch on it.
        if (!result.ok) return httpResult(result, { kind: () => 'conflict' })

        // The pre-batch response shape, for a one-container request only.
        // Reporting the first of six as "the" container would be worse than
        // omitting it.
        const only = result.value.targets.length === 1 ? result.value.targets[0] : undefined

        return httpResult(
          {
            ok: true,
            value: {
              ...result.value,
              ...(only === undefined ? {} : { container: only.container, toTag: only.toTag }),
            },
          },
          { kind: () => 'conflict' },
        )
      },
    },
  },
})
