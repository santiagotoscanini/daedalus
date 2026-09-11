// NixOS release facts that need no network: where a release stands on its
// support window, which release is the newest one out, the date a version
// string carries, and the release notes as the manual publishes them, parsed
// into the shape components/release-notes.tsx already renders. Pure and
// client-safe; the fetching is core/settings/nixos.ts's.

export type NixosCycle = {
  /** `26.05` */
  cycle: string
  codename: string
  /** `YYYY-MM-DD`; empty when the source does not say. */
  releaseDate: string
  /** `YYYY-MM-DD`, the last day of support; empty when the source does not say. */
  eol: string
}

export type Support = {
  state: 'supported' | 'ending' | 'ended'
  eol: string
  /** Whole days from today to `eol`; negative once it has passed. */
  days: number
}

/** A release this close to its end is `ending`: time to plan the move, not yet overdue. */
export const ENDING_DAYS = 45

const DAY_MS = 86_400_000

export function supportOf(eol: string, today: string): Support | null {
  const end = Date.parse(`${eol}T00:00:00Z`)
  const now = Date.parse(`${today}T00:00:00Z`)
  if (!Number.isFinite(end) || !Number.isFinite(now)) return null
  const days = Math.round((end - now) / DAY_MS)
  return { state: days < 0 ? 'ended' : days <= ENDING_DAYS ? 'ending' : 'supported', eol, days }
}

/**
 * The newest release already out on `today`. endoflife.date lists a release
 * before it ships, and a box cannot move to a release that does not exist yet.
 */
export function latestCycle(cycles: readonly NixosCycle[], today: string): NixosCycle | null {
  const out = cycles.filter((c) => c.releaseDate !== '' && c.releaseDate <= today)
  out.sort((a, b) => (a.releaseDate < b.releaseDate ? 1 : a.releaseDate > b.releaseDate ? -1 : 0))
  return out[0] ?? null
}

/** `25.11.20260630.b6018f8` → `2026-06-30`, the date of the locked nixpkgs commit. */
export function builtOn(version: string): string | null {
  const m = /^\d+\.\d+\.(\d{4})(\d{2})(\d{2})\./.exec(version)
  return m === null ? null : `${m[1] ?? ''}-${m[2] ?? ''}-${m[3] ?? ''}`
}

/** The release's notes file in nixpkgs: `26.05` → `rl-2605.section.md`. */
export function notesFile(release: string): string | null {
  const m = /^(\d{2})\.(\d{2})$/.exec(release)
  return m === null ? null : `rl-${m[1] ?? ''}${m[2] ?? ''}.section.md`
}

/** Same shape as components/release-notes.tsx's `Release`. */
export type NixosNotes = {
  version: string
  date: string
  url: string
  sections: { name: string; items: string[] }[]
  truncated: boolean
}

/**
 * Items kept per section. Highlights run to about a dozen; the backward
 * incompatibilities run to sixty, and every entry links to all of them.
 */
export const MAX_NOTES_ITEMS = 12

const ITEM_CHARS = 400

/**
 * A release-notes file into sections of plain-text items.
 *
 * The manual's markdown is regular and this reads only what it uses: a
 * `## Heading {#anchor}` opens a section, a `- ` at the start of a line opens
 * an item, and indented lines directly under it continue it until a blank
 * line. So an item is its first paragraph, which is where every entry says
 * what changed. Skipped: the `#` title, the HTML comments asking contributors
 * to avoid merge conflicts, fenced code, and nested bullets.
 */
export function parseNixosNotes(
  md: string,
  maxItems = MAX_NOTES_ITEMS,
): { sections: NixosNotes['sections']; truncated: boolean } {
  const sections: NixosNotes['sections'] = []
  let truncated = false
  let section: { name: string; items: string[] } | null = null
  let item: string[] | null = null
  let fenced = false

  const endItem = () => {
    if (section !== null && item !== null) {
      const text = leadOnly(plain(item.join(' ')))
      if (text !== '') {
        section.items.push(text.length > ITEM_CHARS ? `${text.slice(0, ITEM_CHARS)}…` : text)
      }
    }
    item = null
  }

  const endSection = () => {
    endItem()
    if (section !== null && section.items.length > 0) {
      if (section.items.length > maxItems) truncated = true
      sections.push({ name: section.name, items: section.items.slice(0, maxItems) })
    }
    section = null
  }

  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      endItem()
      fenced = !fenced
      continue
    }
    if (fenced || line.trimStart().startsWith('<!--') || line.startsWith('# ')) continue

    const heading = /^##\s+(.+?)\s*(\{#[^}]*\})?\s*$/.exec(line)
    if (heading !== null) {
      endSection()
      section = { name: plain(heading[1] ?? ''), items: [] }
    } else if (line.startsWith('- ')) {
      endItem()
      item = [line.slice(2)]
    } else if (line.trim() === '' || /^\s+[-*+]\s/.test(line)) {
      endItem()
    } else if (item !== null && /^\s+\S/.test(line)) {
      item.push(line.trim())
    }
  }
  endSection()

  return { sections, truncated }
}

/**
 * A first paragraph sometimes ends by introducing the code block under it
 * ("For example,"), which reads as a sentence cut off once the block is not
 * shown. The introduction is dropped when a whole sentence comes before it.
 */
function leadOnly(text: string): string {
  if (!/[,:]$/.test(text)) return text
  const cut = text.replace(/\s+[^.]*[,:]$/, '')
  return cut !== text && cut.endsWith('.') ? cut : text
}

/** The manual's inline markdown as plain text. */
export function plain(s: string): string {
  return (
    s
      // `[](#opt-services.foo.enable)` renders as the option's own name.
      .replace(/\[\]\(#opt-([^)]+)\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<!--.*?-->/g, '')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  )
}
