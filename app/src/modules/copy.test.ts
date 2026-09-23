import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// A module view may not name the box it happens to be running on.
//
// The engine is published; every host that enables a module renders the same
// views. A sentence naming this domain, this operator or this machine is true
// here and false everywhere else, and nothing in a type checker or a browser
// walk catches it. Three such sentences shipped in one afternoon — "every
// workflow on it is inactive today", "serving Bazarr's subtitles today", "the
// PC and the Mac would take theirs" — which is why this is a test and not a
// review habit. A view that needs to name something reads it from data:
// `ctx.site`, a loader, the node's own row.
//
// ── a rule that was tried and removed, so it is not tried again ──────────
//
// The obvious companion is "no present-tense claim about what the fleet
// currently holds". It cannot be written as a source check. Both of these are
// string literals in a view:
//
//   'Every workflow on it is inactive today'     ← a hardcoded claim
//   'None of them exists on the gateway today'   ← rendered only when
//                                                  `data.rejected.live === 0`
//
// Telling them apart needs the surrounding code's meaning, so every regex
// that catches the first also catches the second, and enforcing it would mean
// an exception list covering correct code. That is worse than no test: it
// teaches the next reader to silence the rule. The claim half stays a review
// question; only the objective half is mechanical.

const VIEWS = 'src/modules'

/** This box's identity. A view that needs the domain reads `ctx.site.baseDomain`. */
const OWN_NAMES = /\b(toscanini\.me|s2-server|santiago|gaming-pc|macbook-pro|SANTI-PC)\b/i

function views(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return views(path)
    return /\/view\/.*\.tsx$/.test(path) ? [path] : []
  })
}

/**
 * What the page SAYS. Comments are allowed to name the box — they carry the
 * history that explains the code, and they never reach a browser.
 */
function prose(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n')
}

describe('what a module view may say', () => {
  const files = views(VIEWS)

  it('finds the views', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it('never names this box', () => {
    const named = files.filter((f) => OWN_NAMES.test(prose(readFileSync(f, 'utf8'))))
    expect(
      named,
      `these views name the box instead of reading it from data: ${named.join(', ')}`,
    ).toEqual([])
  })

  it('knows a box name from an ordinary word', () => {
    expect(OWN_NAMES.test('the gaming-pc serves it')).toBe(true)
    expect(OWN_NAMES.test('reachable at chat.toscanini.me')).toBe(true)
    expect(OWN_NAMES.test('the node serves it')).toBe(false)
    // A comment may say it; the rule only reads prose.
    expect(OWN_NAMES.test(prose('// the gaming-pc taught us this\nconst a = 1'))).toBe(false)
  })
})
