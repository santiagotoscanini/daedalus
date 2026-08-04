import { createFileRoute } from '@tanstack/react-router'
import { sql } from '../lib/db'

// Liveness + readiness. This one path carries three jobs, all declared in
// stacks/daedalus/daedalus.nix as `auth.healthPath = "/api/healthz"`:
//
//   1. the gatus probe (stacks/gatus generates it from the webApp)
//   2. the forward-auth BYPASS — without it every probe would be answered by a
//      302 to Pocket ID, which a dead container would serve just as happily
//   3. the deploy unit's post-restart health check (stacks/apps/assets/deploy.sh)
//
// So it must stay unauthenticated and must mean "serving", not "process
// alive". 200 = up and can reach Postgres; 503 = up but the DB roundtrip
// failed. It returns no data about anything.
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
