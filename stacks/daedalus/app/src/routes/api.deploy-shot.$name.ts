import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'

// Serves an app's post-deploy screenshot (written by shot-deploy-<name> on
// the host, read off the /shotter mount). Sibling of api.shot-run with one
// difference: this file is OVERWRITTEN per deploy rather than write-once, so
// cacheability comes from the ?v= cache-buster the page appends — a new
// deploy mints a new URL and the old cached bytes are simply never asked
// for again.
const APP_NAME = /^[a-z0-9-]+$/

export const Route = createFileRoute('/api/deploy-shot/$name')({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const miss = new Response(null, { status: 404 })
        if (!APP_NAME.test(params.name)) return miss
        try {
          const body = await readFile(
            join(process.env.SHOTTER_DIR ?? '/shotter', 'deploys', `${params.name}.png`),
          )
          return new Response(new Uint8Array(body), {
            headers: {
              'content-type': 'image/png',
              'cache-control': 'public, max-age=31536000, immutable',
              'x-content-type-options': 'nosniff',
            },
          })
        } catch {
          return miss
        }
      },
    },
  },
})
