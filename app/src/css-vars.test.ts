import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// A CSS variable nothing defines is not an error anywhere: `text-(--x)`
// compiles to `color: var(--x)`, the browser drops the declaration, and the
// text renders in whatever colour it inherits. That is how every refusal on
// the settings pages lost its red for as long as they read `--tone-bad`, a
// name no stylesheet ever set. This is the line that catches the next one.
//
// Defined means one of: a `--name:` declaration in a stylesheet under src/,
// a runtime setter in the source (`style={{ ['--span' as string]: … }}`, or
// lib/tone.ts's `--tone`), a Tailwind arbitrary property (`[--name:…]`), or
// a name the libraries own.

const SRC = import.meta.dirname

/** Set by Tailwind or Radix, not by anything in this tree. */
const EXTERNAL = [/^--spacing$/, /^--tw-/, /^--radix-/]

// A reference is `(--name` right after `var` or a utility's `-`/word char:
// `text-(--dim)`, `min-h-(--row)`, `calc(var(--span)…)`. Prose like
// "(--flag)" and CLI argv strings do not match.
const REF = /[\w-]\((--[a-zA-Z][\w-]*)/g
const CSS_DECL = /(?<![\w-])(--[a-zA-Z][\w-]*)\s*:/g
const SETTER = /['"`](--[a-zA-Z][\w-]*)['"`]\s*(?:as string\s*)?[\]:]/g
const ARBITRARY = /\[(--[a-zA-Z][\w-]*):/g

type Gap = { file: string; name: string }

const names = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1] ?? '')

function undefinedVars(css: string[], sources: Map<string, string>): Gap[] {
  const defined = new Set<string>()
  for (const text of css) for (const n of names(text, CSS_DECL)) defined.add(n)
  for (const text of sources.values()) {
    for (const n of [...names(text, SETTER), ...names(text, ARBITRARY)]) defined.add(n)
  }
  const gaps: Gap[] = []
  for (const [file, text] of sources) {
    for (const name of new Set(names(text, REF))) {
      if (!defined.has(name) && !EXTERNAL.some((re) => re.test(name))) gaps.push({ file, name })
    }
  }
  return gaps
}

function readTree(dir: string, css: string[], sources: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) readTree(p, css, sources)
    else if (entry.name.endsWith('.css')) css.push(readFileSync(p, 'utf8'))
    else if (/\.tsx?$/.test(entry.name) && !/\.(test|gen)\.ts$/.test(entry.name)) {
      sources.set(relative(SRC, p), readFileSync(p, 'utf8'))
    }
  }
}

describe('CSS variables', () => {
  it('every one the source reads is defined somewhere', () => {
    const css: string[] = []
    const sources = new Map<string, string>()
    readTree(SRC, css, sources)
    expect(sources.size).toBeGreaterThan(50)
    expect(undefinedVars(css, sources)).toEqual([])
  })

  it('flags a utility or var() reading a name nothing defines', () => {
    const gaps = undefinedVars(
      [':root { --danger: red; }'],
      new Map([
        ['a.tsx', '<p className="text-(--tone-bad)" />'],
        ['b.tsx', "const X = 'max-h-[calc(var(--row-h)_*_8)]'"],
        ['c.tsx', '<p className="text-(--danger)" />'],
      ]),
    )
    expect(gaps).toEqual([
      { file: 'a.tsx', name: '--tone-bad' },
      { file: 'b.tsx', name: '--row-h' },
    ])
  })

  it('accepts runtime setters, arbitrary properties and library names', () => {
    const gaps = undefinedVars(
      [],
      new Map([
        ['tone.ts', "return { ...extra, ['--tone' as string]: TONE_TOKEN[tone] }"],
        ['row.tsx', '<i className="[--h:2rem] min-h-(--h) bg-(--tone)" />'],
        ['ui.tsx', "'w-(--radix-select-trigger-width) p-[calc(var(--spacing)*4)]'"],
        ['cli.ts', "const usage = 'pass (--older-than) to prune'"],
      ]),
    )
    expect(gaps).toEqual([])
  })
})
