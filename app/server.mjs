// The production entry: `vite build`, then `node server.mjs`.
//
// TanStack Start's build emits `dist/server/server.js` as a fetch handler —
// `export default { fetch }`, zero `.listen()` calls — and `dist/client/` as
// plain files. Nothing in the framework serves either outside `vite preview`,
// which does it with srvx's Node adapter; this file is the same idea
// without Vite in the process. No Nitro: the adapter is only one way to get a
// listener, and it is the way that broke server-function ids in dev.
//
// Order matters: the rejection guard first (a migration can reject too), then
// migrations, then the handler import — `dist/server` opens its Postgres pool
// at import, and a schema it does not expect is a worse failure than a late
// start.

import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { createBrotliCompress, createGzip } from 'node:zlib'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { serve } from 'srvx'

const here = fileURLToPath(new URL('.', import.meta.url))
const CLIENT_DIR = join(here, 'dist', 'client')
const SERVER_ENTRY = join(here, 'dist', 'server', 'server.js')
const MIGRATIONS_DIR = join(here, 'drizzle')

// --- 1. the rejection guard -------------------------------------------------
//
// The same protection `keepServingOnRejection` gives the dev server in
// vite.config.ts, for the same reason: Node turns an unhandled rejection into
// a fatal exception, and the unit over this container is `Type=oneshot` +
// `RemainAfterExit`, so a dead process stays green. One rejected promise in
// one server function deserves a failed request, not a dead control plane.
// Registering a listener at all is what stops the conversion.
process.on('unhandledRejection', (reason) => {
  console.error('[daedalus] unhandled rejection — kept serving:', reason)
})

// --- 2. migrations ----------------------------------------------------------
//
// drizzle's migrator and `drizzle-kit migrate` keep the same ledger
// (`drizzle.__drizzle_migrations`), so a database migrated by hand
// (`pnpm db:migrate`, the dev-mode path) is picked up where it stands. Its own one-connection client, closed before
// the app opens its pool. A failure here exits non-zero on purpose: serving
// on a schema the code does not match is how data gets damaged.
async function runMigrations() {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') throw new Error('DATABASE_URL is not set')
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR })
  } finally {
    await sql.end({ timeout: 5 })
  }
}

// --- 3. static files --------------------------------------------------------
//
// Indexed once at start: the set of files is fixed for the life of a build,
// and a Map lookup means a request path never touches the filesystem unless
// it names a real file — no traversal to defend against.
//
// `/assets/*` names carry a content hash, so they are immutable for a year.
// Everything else in `dist/client` came from `public/` under a stable name
// (icons, part photos) and may change between builds: an hour, revalidated.

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}

const COMPRESSIBLE = new Set([
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.map',
  '.txt',
  '.html',
  '.svg',
  '.webmanifest',
])

/** @returns {Promise<Map<string, { file: string, size: number, mtime: Date, ext: string }>>} */
async function indexClient() {
  const index = new Map()
  const entries = await readdir(CLIENT_DIR, { recursive: true, withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const file = join(entry.parentPath, entry.name)
    const info = await stat(file)
    const urlPath = `/${relative(CLIENT_DIR, file).split(sep).join('/')}`
    index.set(urlPath, {
      file,
      size: info.size,
      mtime: info.mtime,
      ext: extname(file).toLowerCase(),
    })
  }
  return index
}

function staticResponse(request, entry, urlPath) {
  const headers = new Headers({
    'content-type': MIME[entry.ext] ?? 'application/octet-stream',
    'cache-control': urlPath.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600, must-revalidate',
    'last-modified': entry.mtime.toUTCString(),
  })

  const since = request.headers.get('if-modified-since')
  if (
    since !== null &&
    Math.floor(entry.mtime.getTime() / 1000) <= Math.floor(Date.parse(since) / 1000)
  ) {
    return new Response(null, { status: 304, headers })
  }

  const compressible = COMPRESSIBLE.has(entry.ext)
  const accepts = compressible ? (request.headers.get('accept-encoding') ?? '') : ''
  let encoding = null
  if (/\bbr\b/.test(accepts)) encoding = 'br'
  else if (/\bgzip\b/.test(accepts)) encoding = 'gzip'
  if (compressible) headers.set('vary', 'Accept-Encoding')
  if (encoding === null) headers.set('content-length', String(entry.size))
  else headers.set('content-encoding', encoding)

  if (request.method === 'HEAD') return new Response(null, { headers })

  let stream = createReadStream(entry.file)
  if (encoding === 'br') stream = stream.pipe(createBrotliCompress())
  else if (encoding === 'gzip') stream = stream.pipe(createGzip())
  return new Response(Readable.toWeb(stream), { headers })
}

// --- 4. serve ---------------------------------------------------------------

const started = performance.now()
await runMigrations()
const migrated = performance.now()

const [{ default: app }, files] = await Promise.all([import(SERVER_ENTRY), indexClient()])

const server = serve({
  port: process.env.PORT ?? 3000,
  // The container has no host port; traefik dials it over a private bridge.
  hostname: process.env.HOST ?? '0.0.0.0',
  silent: true,
  // Ours, below: srvx's closes the listener and then waits for a process that
  // never empties its event loop (the Postgres pool, the build scheduler).
  gracefulShutdown: false,
  fetch(request) {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const { pathname } = new URL(request.url)
      let decoded = pathname
      try {
        decoded = decodeURIComponent(pathname)
      } catch {
        // A malformed escape names no file; the app answers it.
      }
      const entry = files.get(decoded)
      if (entry !== undefined) return staticResponse(request, entry, decoded)
      // A hashed name that is not in this build is a tab from the previous
      // one. It gets a bare 404, not the app's whole not-found page rendered
      // as a script.
      if (decoded.startsWith('/assets/')) return new Response('Not Found', { status: 404 })
    }
    return app.fetch(request)
  },
  error(error) {
    console.error('[daedalus] request failed outside the app handler:', error)
    return new Response('Internal Server Error', { status: 500 })
  },
})

await server.ready()

// Run without `--init`, node is PID 1, where a signal with no handler is
// ignored and `podman stop` waits out its ten seconds before SIGKILL; under
// the apps platform's `--init` the default handler would drop in-flight
// requests instead. Either way: stop accepting, give in-flight requests a
// moment, then leave — the pool and the scheduler's timers would otherwise
// hold the process open after the listener closes.
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) process.exit(1)
    stopping = true
    console.log(`[daedalus] ${signal} — closing`)
    const force = setTimeout(() => process.exit(0), 5_000)
    force.unref()
    server.close().finally(() => process.exit(0))
  })
}
console.log(
  `[daedalus] serving ${server.url} — migrations ${Math.round(migrated - started)}ms, ` +
    `ready in ${Math.round(performance.now() - started)}ms, ${files.size} static files`,
)
