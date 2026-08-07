import { createFileRoute } from '@tanstack/react-router'
import { appIcon } from '../lib/app-icon'
import { effectiveHostname } from '../lib/hostname'
import { getApp } from '../lib/repo/apps'

// Serves an app's own icon, fetched from the app. See lib/app-icon.ts for why
// it is read from the app rather than stored beside it.
//
// Proxied through here rather than pointed at directly with an <img src> to
// the app's hostname, for three reasons: an app with stage = "off" has no
// hostname to point at, a forward-auth'd app would answer the browser with a
// redirect to Pocket ID, and daedalus can reach a container over app-db-net
// that the page's origin cannot. The bytes are already in memory from the
// resolve, so proxying costs nothing extra.
export const Route = createFileRoute('/api/app-icon/$name')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        // A plain 404 Response rather than `notFound()`: this endpoint answers
        // an <img>, and the router's not-found path would hand it a 200 with a
        // JSON body — which a browser would try to decode as an image.
        const miss = new Response(null, { status: 404 })

        const record = await getApp(params.name)
        if (!record) return miss

        const icon = await appIcon(
          record.name,
          effectiveHostname(record.name, record.hostname),
          record.stage !== 'off',
        )
        // The page has already asked whether an icon exists and drawn a
        // monogram if not, so anything arriving here and missing is a real
        // miss, not a case to paper over with a placeholder image.
        if (!icon) return miss

        return new Response(new Uint8Array(icon.body), {
          headers: {
            'content-type': icon.contentType,
            // Matches the resolver's own TTL. An app that redeploys with a new
            // icon shows it within the hour; nothing here is worth a
            // cache-busting query string on every list row.
            'cache-control': 'public, max-age=3600',
            // These are third-party bytes from an app's own public directory.
            // An SVG is a document that can carry script, so it is served
            // under a CSP that permits none and is never treated as active
            // content by the browser.
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            'x-content-type-options': 'nosniff',
          },
        })
      },
    },
  },
})
