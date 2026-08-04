import { createFileRoute } from '@tanstack/react-router'

// Trigger an apply without the UI, and read back where it got to.
//
// Same code path as the Apply button (both call requestApply) — this is not a
// second implementation, it is the scriptable door onto the first. Useful for
// testing the host agent and for a future "apply on a schedule" without
// anything having to drive a browser.
//
// Behind the forward-auth gate like everything except /api/healthz and
// /api/info, so a request that reaches this from outside has passed Pocket ID.
export const Route = createFileRoute('/api/registry/apply')({
  server: {
    handlers: {
      GET: async () => {
        const { readApplyStatus } = await import('../lib/apply')
        return Response.json(await readApplyStatus())
      },

      POST: async ({ request }) => {
        const { listApps, toRegistryExport, driftOf } = await import('../lib/repo/apps')
        const { manifestEntries } = await import('../lib/nix-manifest')
        const { requestApply, summarise, readApplyStatus } = await import('../lib/apply')
        const { renderRegistryFile } = await import('../lib/registry-file')

        // Same guard as the UI path: the host script's flock would serialise a
        // second apply anyway, but it would then commit a registry snapshot
        // taken before the first one landed.
        const inFlight = await readApplyStatus()
        if (inFlight.state === 'running') {
          return Response.json(
            { status: 'busy', reason: `an apply is already running (${inFlight.phase})` },
            { status: 409 },
          )
        }

        const records = await listApps()
        const manifest = new Map((await manifestEntries()).map((m) => [m.name, m]))

        const changed = records
          .filter((r) => !r.managedInNix)
          .map((r) => ({ name: r.name, fields: driftOf(r, manifest.get(r.name)) }))
          .filter((c) => c.fields.length > 0)

        if (changed.length === 0) {
          return Response.json({ status: 'noop', reason: 'nothing to apply' }, { status: 409 })
        }

        const id = await requestApply({
          fileBody: renderRegistryFile(toRegistryExport(records)),
          summary: summarise(changed),
          actor: request.headers.get('x-forwarded-email') ?? 'api',
        })

        return Response.json({ status: 'queued', id, changed })
      },
    },
  },
})
