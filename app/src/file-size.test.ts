import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// A component file past 400 lines is several components in a coat, and the
// next edit to it is a merge conflict with whoever is in the other half. The
// pages are split by board and by page (one file per service, one component
// per Board), and this keeps them that way.
//
// Allowed past the line: what is generated or vendored (the route tree, the
// shadcn kit under components/ui), and a file another change has open — say
// why next to it, and take it off when that lands.

const SRC = import.meta.dirname
const MAX_LINES = 400

const ALLOWED: Record<string, string> = {
  'modules/system/view/updates.tsx':
    'System › Updates: its data plumbing is being moved onto the root helper; split after that lands',
}

/** As `wc -l` counts them: the newline that ends the last line is not a line. */
const lineCount = (text: string): number => text.split('\n').length - (text.endsWith('\n') ? 1 : 0)

const exempt = (path: string): boolean =>
  path.startsWith('components/ui/') || path.endsWith('.gen.tsx') || path in ALLOWED

function tsxFiles(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) tsxFiles(p, out)
    else if (entry.name.endsWith('.tsx')) out.push(relative(SRC, p))
  }
  return out
}

describe('component files', () => {
  it(`stay under ${String(MAX_LINES)} lines`, () => {
    const files = tsxFiles(SRC, [])
    expect(files.length).toBeGreaterThan(100)
    const long = files
      .filter((f) => !exempt(f))
      .map((f) => ({ file: f, lines: lineCount(readFileSync(join(SRC, f), 'utf8')) }))
      .filter((f) => f.lines > MAX_LINES)
    expect(long).toEqual([])
  })

  it('allows only files that exist', () => {
    const files = new Set(tsxFiles(SRC, []))
    expect(Object.keys(ALLOWED).filter((f) => !files.has(f))).toEqual([])
  })
})
