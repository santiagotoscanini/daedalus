import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// app.css pins the directories Tailwind scans (`source(none)` + `@source`),
// so a directory of components that is not named there renders with every
// utility only it uses silently missing — which is how the hardware photos
// on System grew to the width of their boards for a week after the views
// moved into src/modules. This test is the line that would have caught it.

const SRC = join(import.meta.dirname, '.')

function hasTsx(dir: string): boolean {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (hasTsx(p)) return true
    } else if (entry.endsWith('.tsx')) {
      return true
    }
  }
  return false
}

describe('app.css @source', () => {
  it('names every directory under src that holds .tsx files', () => {
    const css = readFileSync(join(SRC, 'app.css'), 'utf8')
    const sources = new Set([...css.matchAll(/^@source\s+"\.\/([^"]+)";/gm)].map((m) => m[1]))
    const withComponents = readdirSync(SRC)
      .filter((e) => statSync(join(SRC, e)).isDirectory() && hasTsx(join(SRC, e)))
      .sort()
    for (const dir of withComponents) {
      expect(sources, `src/${dir} holds .tsx files but app.css has no @source for it`).toContain(
        dir,
      )
    }
  })
})
