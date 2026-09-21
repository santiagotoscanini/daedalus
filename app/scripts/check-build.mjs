// Fails a build that would only fail later, in a browser.
//
// `vite build` exits 0 over two things that break the running app:
//
//   1. A server-only module in a browser chunk. Vite does not refuse it; it
//      swaps the module for `__vite-browser-external`, a stub that throws on
//      first use — a page that renders and then dies on a click.
//   2. A server-function id the server does not know. Build ids are sha256
//      of `file--function`, computed once per Vite environment (client, ssr);
//      they have always agreed, and "Invalid server function ID" at call time
//      is what it looks like when they do not.
//   3. The box's identity, inlined. Not a crash: a page that renders another
//      box's hostnames, for every box the image is run on. scripts/build.mjs
//      binds a canary to each identity variable before Vite runs, and no
//      canary may be found anywhere in `dist/` — client or server. The
//      placeholders (`unknown-owner`, `localhost`) ARE in the bundle and are
//      not looked for: they are lib/site.ts's fallbacks, what a box that binds
//      nothing reads, and no build put them there in a box's place.
//
// Run by `pnpm build` (scripts/build.mjs), after Vite. No dependencies: it
// reads `dist/`.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('../dist/', import.meta.url).pathname
const problems = []

async function chunks(dir) {
  const names = await readdir(dir, { recursive: true })
  return names.filter((n) => n.endsWith('.js')).map((n) => join(dir, n))
}

const ID = /[`"']([0-9a-f]{64}(?:_\d+)?)[`"']/g
const clientIds = new Set()
for (const file of await chunks(join(root, 'client'))) {
  const text = await readFile(file, 'utf8')
  if (text.includes('__vite-browser-external'))
    problems.push(`${file}: a Node module was stubbed into a browser chunk`)
  if (/from\s*["'`]node:|import\(\s*["'`]node:/.test(text))
    problems.push(`${file}: imports a node: module`)
  for (const m of text.matchAll(ID)) clientIds.add(m[1])
}

// Every identity variable this process was handed a canary for. Run bare —
// `vite build && node scripts/check-build.mjs` — there are none, and the
// summary says the check did not happen rather than that it passed.
const canaries = Object.entries(process.env).filter(
  ([name, value]) =>
    /^(VITE_)?(BASE_DOMAIN|GITHUB_OWNER|REGISTRY_HOST|GRAFANA_URL)$/.test(name) &&
    value?.includes('build-canary'),
)
if (canaries.length > 0) {
  const all = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name))
  for (const file of all) {
    const text = await readFile(file, 'latin1')
    for (const [name, value] of canaries)
      if (text.includes(value))
        problems.push(
          `${file}: ${name} was inlined at build time — the identity is read at run time (src/host/site.ts)`,
        )
  }
}

const serverIds = new Set()
for (const m of (await readFile(join(root, 'server', 'server.js'), 'utf8')).matchAll(ID))
  serverIds.add(m[1])

const unknown = [...clientIds].filter((id) => !serverIds.has(id))
if (clientIds.size === 0)
  problems.push(
    'no server-function ids found in the client chunks — the id format changed; update this check',
  )
for (const id of unknown)
  problems.push(`client calls server function ${id}, which the server manifest does not list`)

if (problems.length > 0) {
  console.error(
    `check-build: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`,
  )
  process.exit(1)
}
console.log(
  `check-build: ok — ${clientIds.size} server-function ids, all known to the server; no Node modules in browser chunks; ${
    canaries.length > 0
      ? `none of ${canaries.length} identity canaries inlined`
      : 'identity canaries not bound, so inlining was NOT checked (use scripts/build.mjs)'
  }`,
)
