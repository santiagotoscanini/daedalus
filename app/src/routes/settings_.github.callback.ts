import { createFileRoute } from '@tanstack/react-router'

// Where GitHub sends the browser after the operator confirms the App's
// manifest: `?code&state`. Behind the Pocket ID gate like every page, so the
// actor is the forwarded email. All the work is core/settings/github-app.ts;
// this only answers with a relative redirect back to Settings, whose query
// carries an outcome and a fixed reason CODE (never text, the code, the state
// or a secret); the detail goes to the server log.
//
// Trailing `_` on `settings`: settings.tsx renders no <Outlet/>, so this path
// must not nest under it.

export const Route = createFileRoute('/settings_/github/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const { makeCtx } = await import('../core/ctx')
          const { githubCallback } = await import('../core/settings/github-app')
          return await githubCallback(await makeCtx(), request)
        } catch (e) {
          // The name only: a message from this far down could quote the request.
          console.warn(
            `[github-app] callback could not run: ${e instanceof Error ? e.name : 'non-Error thrown'}`,
          )
          return new Response(null, {
            status: 302,
            headers: {
              Location: '/settings?tab=integrations&github=failed&reason=unknown',
              'Cache-Control': 'no-store',
              'Referrer-Policy': 'no-referrer',
            },
          })
        }
      },
    },
  },
})
