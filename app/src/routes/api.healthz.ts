import { createFileRoute } from '@tanstack/react-router'
import { sql } from '../host/db'

// Liveness + readiness. This one path carries three jobs, all following from
// `auth.healthPath = "/api/healthz"` in nix/stacks/daedalus/self.json:
//
//   1. the gatus probe (nix/modules/gatus generates it from the webApp)
//   2. the forward-auth BYPASS — without it every probe would be answered by a
//      302 to Pocket ID, which a dead container would serve just as happily
//   3. the deploy unit's post-restart health check
//      (nix/modules/apps/assets/deploy.sh) — on a host running the published
//      image; dev mode has no deploy unit
//
// So it must stay unauthenticated and must mean "serving", not "process
// alive". 200 = up and can reach Postgres; 503 = up but the DB roundtrip
// failed. It returns no data about anything, and it starts nothing: the
// process's own work is host/background.ts's, started once at process start.
export const Route = createFileRoute('/api/healthz')({
  server: {
    handlers: {
      GET: async () => {
        try {
          await sql`SELECT 1`
          return Response.json({ status: 'ok' }, { status: 200 })
        } catch {
          return Response.json({ status: 'db_unreachable' }, { status: 503 })
        }
      },
    },
  },
})
