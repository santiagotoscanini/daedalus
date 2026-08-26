import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'

// Serves one screenshot out of a shotter run directory, for the thumbnails
// on the Claude page. Proxied through here rather than pointed at directly
// because the archive exists only as this container's read-only /shotter
// mount — there is no hostname a browser could fetch it from.

// The two patterns are the whole traversal defence: no separator can appear,
// so `join` below cannot leave the run directory, and anything the runner
// would not have named this way is a miss rather than a probe result.
const RUN_ID = /^[0-9]{8}-[0-9]{6}-[A-Za-z0-9._-]+$/
const SHOT_FILE = /^[A-Za-z0-9._-]+\.png$/

export const Route = createFileRoute('/api/shot-run/$run/$file')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        // A plain 404 rather than `notFound()`, for the same reason as the
        // app-icon route: this answers an <img>, and the router's not-found
        // path would hand it a 200 with a JSON body.
        const miss = new Response(null, { status: 404 })
        if (!RUN_ID.test(params.run) || !SHOT_FILE.test(params.file)) return miss
        try {
          const body = await readFile(
            join(process.env.SHOTTER_DIR ?? '/shotter', 'runs', params.run, params.file),
          )
          return new Response(new Uint8Array(body), {
            headers: {
              'content-type': 'image/png',
              // A run directory is write-once — the id embeds its own
              // timestamp — so these bytes never change under their URL.
              'cache-control': 'public, max-age=604800, immutable',
              'x-content-type-options': 'nosniff',
            },
          })
        } catch {
          // Pruned since the page rendered, or never existed.
          return miss
        }
      },
    },
  },
})
