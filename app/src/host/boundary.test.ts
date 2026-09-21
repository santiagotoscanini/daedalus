// The one test that keeps `src/host/` honest.
//
// `src/host/` exists to answer, from the path alone, the first question a
// reviewer has about any module: does this run in the browser? Everything in
// it needs the machine — a node builtin, the database, or `process.env` — and
// nothing outside the server regions listed below may.
//
// Biome cannot express this. `noRestrictedImports` has no type-import
// exemption, so it would fire on the legitimate `import type` edges that carry
// a host module's result shape into a component, and it cannot follow an edge
// two modules deep. So: a real import graph, walked here.
//
// What counts as an edge, and why:
//
//   `import type X from 'y'` / `export type { X } from 'y'` — NOT an edge.
//   `verbatimModuleSyntax` erases those statements whole; nothing is emitted,
//   so no bundler ever follows them. This is what makes it safe for a
//   component to name a host module's return type.
//
//   `import { type X } from 'y'` — IS an edge. `verbatimModuleSyntax` emits
//   `import {} from 'y'` for it, which still loads the module. The one-keyword
//   difference between this and the line above is exactly the mistake this
//   test exists to catch.
//
//   `await import('y')` — NOT an edge. It is this codebase's deliberate
//   mechanism for reaching server code from a module the client also loads:
//   `createServerFn().handler(...)` bodies are erased from the client build,
//   which is why every value import inside one is dynamic.
//
// So the graph here is static value imports only — precisely what a bundler
// drags into the chunk that names the importer.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = 'src'

/**
 * Regions that are allowed to need the machine. Everything else in `src` must
 * be pure.
 *
 * `lib/repo`, `lib/dashboard` and `lib/apps` are server-only too and stay in
 * `lib/` on purpose: their names already say what they are (the drizzle
 * repositories, the category pages' data layer, and the Apps page's), which is
 * the same standard `host/` is held to. `routes/api.*` are server routes that
 * never reach a browser; `server/**` is the createServerFn seam, which has a
 * rule of its own below.
 */
const SERVER_REGIONS = [
  (f: string) => f.startsWith('src/host/'),
  (f: string) => f.startsWith('src/core/'),
  (f: string) => f.startsWith('src/server/'),
  (f: string) => f.startsWith('src/lib/repo/'),
  (f: string) => f.startsWith('src/lib/dashboard/'),
  (f: string) => f.startsWith('src/lib/apps/'),
  (f: string) => /^src\/routes\/api\./.test(f),
  // A module's data half. Its manifest and releases are pure by contract and
  // its view half is client code — see below.
  (f: string) => /^src\/modules\/[^/]+\/data\//.test(f),
]

const isServerRegion = (f: string) => SERVER_REGIONS.some((p) => p(f))

/** `src/server/**` is the seam, not a layer: traversal stops there. */
const isSeam = (f: string) => f.startsWith('src/server/')

/** Client code: shipped to the browser, must reach nothing on this list. */
const isClient = (f: string) =>
  f.startsWith('src/components/') ||
  (f.startsWith('src/routes/') && !/^src\/routes\/api\./.test(f)) ||
  /^src\/modules\/[^/]+\/view\//.test(f) ||
  /^src\/modules\/[^/]+\/(manifest|releases)\.ts$/.test(f)

/** A dashboard module's files, which reach the machine only through their `Ctx`. */
const isModule = (f: string) => f.startsWith('src/modules/')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(p)
  }
  return out
}

// The shipped graph only. `routeTree.gen.ts` is generated and gitignored;
// `*.test.ts` always runs in node, is imported by nothing, and is allowed its
// `node:fs` and its mocks.
const files = walk(SRC)
  .filter((f) => !f.endsWith('routeTree.gen.ts') && !/\.test\.tsx?$/.test(f))
  .sort()

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')

// An import/export clause never contains `;` or `=`, which is what keeps this
// from running off the end of a statement and finding some later `from`.
const FROM = /(?:^|\n)\s*(import|export)(\s+type\b)?([^;=]*?)(?<![.\w])from\s*['"]([^'"]+)['"]/g
const SIDE_EFFECT = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g

type Module = { statics: string[]; usesProcessEnv: boolean; inlinesEnv: boolean }

const parsed = new Map<string, Module>()
for (const f of files) {
  const src = stripComments(readFileSync(f, 'utf8'))
  const statics: string[] = []
  for (const m of src.matchAll(FROM)) if (!m[2]) statics.push(m[4] as string)
  for (const m of src.matchAll(SIDE_EFFECT)) statics.push(m[1] as string)
  parsed.set(f, {
    statics,
    usesProcessEnv: /process\.env/.test(src),
    inlinesEnv: /import\.meta\.env\.VITE_/.test(src),
  })
}

/** Extensionless relative imports, resolved the way Vite's resolver does. */
function resolveSpec(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null
  const base = resolve(dirname(from), spec)
  for (const c of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    try {
      if (statSync(c).isFile()) return relative(process.cwd(), c)
    } catch {
      // not this candidate
    }
  }
  return null
}

const isNodeBuiltin = (s: string) => s.startsWith('node:')
const isDatabase = (s: string) => s === 'postgres' || s.startsWith('drizzle-orm')

/** Why a module needs the machine, or null if it does not. */
function ownReason(f: string): string | null {
  const mod = parsed.get(f)
  if (!mod) return null
  // The seam is not a seed either: a `process.env` read inside a
  // `createServerFn` handler is erased from the client build along with the
  // handler. What the seam owes instead is the third assertion below.
  if (isSeam(f)) return null
  const builtins = mod.statics.filter(isNodeBuiltin)
  if (builtins.length > 0) return `imports ${builtins.join(', ')}`
  const db = mod.statics.filter(isDatabase)
  if (db.length > 0) return `imports ${db.join(', ')}`
  if (mod.usesProcessEnv) return 'reads process.env'
  return null
}

const edges = new Map<string, string[]>(
  files.map((f) => [
    f,
    (parsed.get(f)?.statics ?? [])
      .map((s) => resolveSpec(f, s))
      .filter((t): t is string => t !== null),
  ]),
)

// The taint set: modules that need the machine, plus every module that
// statically imports one. Traversal does not pass through the seam.
const reason = new Map<string, string>()
for (const f of files) {
  const own = ownReason(f)
  if (own !== null) reason.set(f, own)
}
for (let moved = true; moved; ) {
  moved = false
  for (const [f, deps] of edges) {
    if (reason.has(f) || isSeam(f)) continue
    const tainted = deps.find((d) => reason.has(d))
    if (tainted !== undefined) {
      reason.set(f, `imports ${tainted}`)
      moved = true
    }
  }
}

/** The shortest static import chain from `f` into the taint set. */
function chain(f: string): string[] {
  const path = [f]
  for (let at = f; ; ) {
    const next = (edges.get(at) ?? []).find((d) => reason.has(d) && !isSeam(d))
    if (next === undefined) return path
    path.push(next)
    at = next
  }
}

describe('the host boundary', () => {
  it('finds the code it is supposed to be checking', () => {
    // A parser that silently matched nothing would make every assertion below
    // pass for the wrong reason.
    expect(files.length).toBeGreaterThan(250)
    expect([...reason.keys()].filter((f) => f.startsWith('src/host/')).length).toBeGreaterThan(30)
  })

  it('never lets client code reach a module that needs the machine', () => {
    const offenders = files
      .filter((f) => isClient(f) && reason.has(f))
      .map(
        (f) => `${f}\n    ${chain(f).join('\n    → ')}\n    (${reason.get(chain(f).at(-1) ?? f)})`,
      )
    expect(offenders, offenders.join('\n\n')).toEqual([])
  })

  it('keeps the createServerFn seam free of static server imports', () => {
    // Every value import in `src/server/**` must be dynamic — a static one
    // would put the module it names in the client chunk of every route that
    // imports the server function.
    const offenders = files
      .filter(isSeam)
      .flatMap((f) => (edges.get(f) ?? []).filter((d) => reason.has(d)).map((d) => `${f} → ${d}`))
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('keeps process.env out of the dashboard modules', () => {
    // A module loader is handed a Ctx and reaches the box through it. A
    // `process.env` read in one is a configuration path the Ctx does not
    // know about, which is exactly what the capability set exists to prevent.
    //
    // `host/env.ts` is where every other `process.env` read in the app now
    // goes, so importing it is the same reach by another name — the LiteLLM
    // loader did exactly that until the gateway became a capability.
    const offenders = files.filter(
      (f) =>
        isModule(f) &&
        (parsed.get(f)?.usesProcessEnv === true ||
          (edges.get(f) ?? []).includes('src/host/env.ts')),
    )
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('keeps configuration out of import.meta.env', () => {
    // Vite replaces `import.meta.env.VITE_*` with a literal in BOTH bundles,
    // at build time, and an image is built once for every box: whatever is
    // read that way is the build machine's value forever. The box's identity
    // went this way once (lib/site.ts). Configuration is `host/env.ts` on the
    // server and the root loader's data in the browser; `scripts/build.mjs`
    // asserts the same thing about `dist/`.
    const offenders = files.filter((f) => parsed.get(f)?.inlinesEnv === true)
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('keeps every module that needs the machine inside a server region', () => {
    // The assertion that makes the directory name true rather than merely
    // accurate today: add `node:fs` to a file in `src/lib/`, and this fails
    // pointing at it. The fix is to move the file to `src/host/`.
    const misplaced = files
      .filter((f) => reason.has(f) && !isServerRegion(f))
      .map((f) => `${f} — ${reason.get(f)}`)
    expect(misplaced, misplaced.join('\n')).toEqual([])
  })
})
