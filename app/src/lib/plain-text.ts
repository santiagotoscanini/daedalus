// Markup → plain text, for the release notes the dashboard scrapes from vendor
// pages (the Postgres docs, the Factorio forum feed, GitHub release bodies, the
// NixOS manual).
//
// Every output here reaches the page as a React text node, never as HTML, so
// none of this is what keeps a page safe. It is written the way a sanitizer
// has to be anyway, because the loose versions were wrong on their own terms
// and CodeQL rightly said so: entities decode in ONE pass, so `&amp;lt;` comes
// out as the text `&lt;` and not as `<`; tags and comments are removed until
// none are left, rather than in one pass that can splice a new one together.

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  nbsp: ' ',
  '#8212': '—',
}

/** The handful of entities these sources use, decoded in a single pass. */
export function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp|#8212);/g, (m, name: string) => ENTITIES[name] ?? m)
}

/** Replaces `pattern` until the string stops changing. */
function untilStable(s: string, pattern: RegExp): string {
  let out = s
  let prev: string
  do {
    prev = out
    out = out.replace(pattern, '')
  } while (out !== prev)
  return out
}

/** Every `<…>` tag, removed. */
export function stripTags(s: string): string {
  return untilStable(s, /<[^>]+>/g)
}

/** Every HTML comment, removed — across lines, `--!>` endings, and one left open at the end. */
export function stripComments(s: string): string {
  return untilStable(s, /<!--[\s\S]*?(?:--!?>|$)/g)
}
