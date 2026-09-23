import { createFileRoute } from '@tanstack/react-router'
import { ensureScheduler } from '../core/builds/scheduler'
import { sql } from '../host/db'
import { reportEnvOnce } from '../host/env'
import { ensureGatewaySync } from '../host/gateway-sync'

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
        // gatus calling this every minute is what starts the build scheduler
        // in a fresh process. Synchronous and idempotent; adds nothing to the answer.
        ensureScheduler()
        // And the gateway sync's five-minute run, the same way.
        ensureGatewaySync()
        // And the environment's startup report: malformed optional variables
        // warned about once, a required one that is missing thrown — a 500 here
        // is what fails the deploy unit's health check and gatus alike.
        reportEnvOnce()
        // Same trick for the break-glass login's setup token: minted and printed
        // once per process, and only while site.json turns the login on and no
        // admin exists. Not awaited — a probe must not wait on it or fail with it.
        void import('../core/local-login').then((m) => m.announceSetupTokenOnce()).catch(() => {})
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
