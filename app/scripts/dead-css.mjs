#!/usr/bin/env node
/**
 * Which rules in styles.css nothing references any more.
 *
 * The Tailwind migration deletes that file class by class, and the danger
 * is deleting one that is still live. A plain grep for the class name is
 * not enough, because this codebase composes class names at runtime:
 *
 *   className={`bigstat bigstat-${tone}`}      // 6 classes, 0 literals
 *   className={`dot dot-${state}`}             // 4 classes, 0 literals
 *
 * So `bigstat-accent` never appears in any source file and a literal
 * search calls it dead while it is on screen. This checks the PREFIX
 * against every template literal too, and reports those separately as
 * "reached by interpolation" rather than folding them into either answer.
 *
 *   node scripts/dead-css.mjs           # summary
 *   node scripts/dead-css.mjs --list    # every dead class, one per line
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const css = readFileSync(join(root, 'src/styles.css'), 'utf8')

const defined = new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]))

let source = ''
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(p)
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.gen.ts')) {
      source += `\n${readFileSync(p, 'utf8')}`
    }
  }
}
walk(join(root, 'src'))

// Every `${…}`-bearing template literal in the source, reduced to the text
// before its first hole: the prefix a composed class name starts with.
const prefixes = [...source.matchAll(/`([^`\\]*?)\$\{/g)]
  .map((m) => m[1].split(/\s/).pop() ?? '')
  .filter((p) => p.length > 2)

const literal = []
const interpolated = []
const dead = []
for (const cls of defined) {
  if (new RegExp(`[\\s"'\`.]${cls}[\\s"'\`]`).test(source)) literal.push(cls)
  else if (prefixes.some((p) => cls.startsWith(p))) interpolated.push(cls)
  else dead.push(cls)
}

if (process.argv.includes('--list')) {
  for (const c of dead.sort()) console.log(c)
} else {
  console.log(`defined in styles.css      ${defined.size}`)
  console.log(`referenced literally       ${literal.length}`)
  console.log(`reached by interpolation   ${interpolated.length}  (DO NOT delete on grep alone)`)
  console.log(`dead                       ${dead.length}`)
  if (interpolated.length > 0) console.log(`\ninterpolated: ${interpolated.sort().join(' ')}`)
}
