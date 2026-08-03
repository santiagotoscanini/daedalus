import { createFileRoute } from '@tanstack/react-router'

// Load the registry from what Nix currently has (the mounted manifest).
//
// This is the seed AND the "re-sync from Nix" direction of the Apply loop —
// the inverse of the export that writes stacks/apps/apps.json. Idempotent, so
// running it twice is a no-op.
//
// POST only: it writes. Trigger it with
//   podman exec app-daedalus node -e 'fetch("http://127.0.0.1:3000/api/registry/import",{method:"POST"}).then(r=>r.text()).then(console.log)'
//
// Unauthenticated in the same sense as the rest of the app: the forward-auth
// middleware gates every path except the health check, so a request that
// reaches this handler from outside has already passed Pocket ID. From inside
// the container it is reachable without a session, which is what makes the
// line above work.
export const Route = createFileRoute('/api/registry/import')({
  server: {
    handlers: {
      POST: async () => {
        const { importFromNix } = await import('../lib/repo/apps')
        try {
          const result = await importFromNix()
          return Response.json({ status: 'ok', ...result })
        } catch (err) {
          return Response.json(
            { status: 'error', error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
    },
  },
})
