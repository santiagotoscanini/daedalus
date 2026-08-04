import { createFileRoute } from '@tanstack/react-router'

// "A new image landed — redeploy this app."
//
// Shaped for two callers:
//   now   — the Redeploy button, and `curl -X POST … -d '{"app":"anansi"}'`
//   next  — zot's push event, once the registry's events extension is wired.
//           `repository` is accepted alongside `app` for exactly that: a
//           registry event names a repo, and on this box the repo name IS the
//           app name (registry.toscanini.me/<app>).
//
// Currently behind the Pocket ID forward-auth gate like everything except
// /api/healthz and /api/info. Wiring zot to it will need a bypass plus a
// shared secret — deliberately NOT done here, because that turns an
// authenticated endpoint into an unauthenticated one that starts privileged
// units, and that deserves its own change.
//
// Validation of the app name happens twice on purpose: loosely here (fail
// fast, useful error) and authoritatively in the host trigger, which checks it
// against the generated allowlist before the name becomes part of a unit that
// root starts. This route is not the security boundary.
export const Route = createFileRoute('/api/deploy')({
  server: {
    handlers: {
      GET: async () => {
        const { readDeployStatus } = await import('../lib/deploy')
        return Response.json(await readDeployStatus())
      },

      POST: async ({ request }) => {
        const { requestDeploy } = await import('../lib/deploy')
        const { getApp } = await import('../lib/repo/apps')

        let body: { app?: unknown; repository?: unknown; reason?: unknown } = {}
        try {
          body = (await request.json()) as typeof body
        } catch {
          return Response.json({ status: 'error', error: 'body must be JSON' }, { status: 400 })
        }

        // A registry event names a repo path; take the last segment so
        // "registry.toscanini.me/anansi" and "anansi" both work.
        const raw = typeof body.app === 'string' ? body.app
          : typeof body.repository === 'string' ? body.repository
          : ''
        const app = raw.split('/').pop() ?? ''

        if (!/^[a-z][a-z0-9-]*$/.test(app)) {
          return Response.json(
            { status: 'error', error: `not a valid app name: '${raw}'` },
            { status: 400 },
          )
        }

        const record = await getApp(app)
        if (!record) {
          return Response.json({ status: 'error', error: `unknown app '${app}'` }, { status: 404 })
        }
        if (record.sourceMode === 'local') {
          return Response.json(
            {
              status: 'error',
              error: `${app} builds from source in the flake repo — there is no image to pull`,
            },
            { status: 409 },
          )
        }

        const id = await requestDeploy({
          app,
          reason: typeof body.reason === 'string' ? body.reason : 'manual trigger',
          actor: request.headers.get('x-forwarded-email') ?? 'api',
        })

        return Response.json({ status: 'queued', id, app })
      },
    },
  },
})
