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
//
// Run by `pnpm build`, after Vite. No dependencies: it reads `dist/`.

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
  `check-build: ok — ${clientIds.size} server-function ids, all known to the server; no Node modules in browser chunks`,
)
