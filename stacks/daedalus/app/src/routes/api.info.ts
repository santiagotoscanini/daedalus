import { createFileRoute } from '@tanstack/react-router'

// Machine-readable summary of the platform, for the homepage tile.
//
// Unauthenticated — it is on the forward-auth bypass list
// (`auth.authBypassRule` in stacks/daedalus/daedalus.nix) so homepage can
// fetch it without a session, exactly like the health check.
//
// That constrains what it may contain. Everything here is either already
// visible on the LAN homepage for other services (names, up/down) or a
// count. NO configuration, no env vars, no notes, no image digests, no drift
// details — a bypassed route is effectively public on the LAN, and this is
// the control plane.
export const Route = createFileRoute('/api/info')({
  server: {
    handlers: {
      GET: async () => {
        const { listApps, driftOf } = await import('../lib/repo/apps')
        const { manifestEntries } = await import('../lib/nix-manifest')
        const { appStatuses } = await import('../lib/metrics')
        const { readApplyStatus } = await import('../lib/apply')

        try {
          const records = await listApps()
          const manifest = new Map((await manifestEntries()).map((m) => [m.name, m]))
          const [statuses, apply] = await Promise.all([
            appStatuses(records.map((r) => r.name)),
            readApplyStatus(),
          ])

          const states = records.map((r) => statuses[r.name]?.state ?? 'unknown')
          const unapplied = records.filter(
            (r) => !r.managedInNix && driftOf(r, manifest.get(r.name)).length > 0,
          ).length

          return Response.json({
            apps: records.length,
            running: states.filter((s) => s === 'running').length,
            attention: states.filter((s) => s === 'attention').length,
            stopped: states.filter((s) => s === 'stopped' || s === 'unknown').length,
            unapplied,
            // Surfaced so a failed apply is visible from the dashboard rather
            // than only inside the app whose rebuild may have just failed.
            applyState: apply.state,
            rpm: Number(
              records
                .reduce((sum, r) => sum + (statuses[r.name]?.rpm ?? 0), 0)
                .toFixed(1),
            ),
            names: records.map((r) => r.name),
          })
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : String(err) },
            { status: 503 },
          )
        }
      },
    },
  },
})
