// "Is it worth updating?" for the one service on this box that does not
// publish GitHub releases.
//
// Postgres is the shared cluster every app is a tenant of, and its minor
// releases are almost entirely security and data-corruption fixes — which
// makes it the single service here where "what changed" matters most and the
// service where ../github.ts cannot answer. The mirror at postgres/postgres
// carries tags and no releases at all, so `versionGap` against it returns an
// empty list and the panel would read "no published notes" forever on a
// project that publishes some of the most carefully written notes in the
// business.
//
// So this is the same contract from a different source. It produces a
// `VersionGap`, identical in shape to what GitHub yields, so `<Changelog>` and
// `verdictOf` work unchanged and the Database tab reads exactly like every
// other service tab.
//
// ── two upstreams, both boring and stable ─────────────────────────────────
//
//   versions.json            — every major, and the newest minor on each. This
//                              is the verdict: a box on 18.4 with 18.6 out is
//                              two behind, and nothing else has to be fetched
//                              to know it.
//   /docs/release/<v>/        — one page per minor, with the notes on it.
//
// Both are static pages on postgresql.org with no key, no rate limit worth
// worrying about, and a layout that has not changed in a decade. The cache
// below is the same two-clock one github.ts uses and exists for the same
// reason: a failure must serve the last good answer rather than blanking the
// panel.

import type { ReleaseNote, VersionGap } from './github'
import { EMPTY_GAP } from './github'

/** Release history moves a handful of times a YEAR. Staleness is free. */
const TTL_MS = 6 * 60 * 60_000
const RETRY_MS = 5 * 60_000

/**
 * Notes fetched per render, newest first.
 *
 * One HTTP request each, so this is the number that bounds how slow a cold
 * Database tab can be. Four covers a year of quarterly minors, which is far
 * more than this box is ever allowed to drift.
 */
const MAX_PAGES = 4

/** Bullets kept per section — the same cut github.ts makes, for the same reason. */
const MAX_ITEMS = 8

type Cached<T> = { at: number; tried: number; value: T | null }
const cache = new Map<string, Cached<unknown>>()

/**
 * Fetch-once-per-TTL, keep the previous answer on failure.
 *
 * Lifted to a helper rather than written twice because this file has two
 * upstreams with identical caching needs, and two hand-rolled copies of a
 * two-clock cache is how one of them quietly loses its stale-serving.
 */
async function cached<T>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key) as Cached<T> | undefined
  const now = Date.now()

  if (hit !== undefined) {
    const fresh = hit.value !== null && now - hit.at < TTL_MS
    const backingOff = now - hit.tried < RETRY_MS
    if (fresh || backingOff) return hit.value
  }

  const value = await load()
  if (value !== null) {
    cache.set(key, { at: now, tried: now, value })
    return value
  }

  cache.set(key, { at: hit?.at ?? 0, tried: now, value: hit?.value ?? null })
  return hit?.value ?? null
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

type Major = { major: string; latestMinor: string; supported: boolean }

/** Every supported major and its newest minor, from postgresql.org. */
async function majors(): Promise<Major[] | null> {
  return cached('versions', async () => {
    const body = await getText('https://www.postgresql.org/versions.json')
    if (body === null) return null
    try {
      return JSON.parse(body) as Major[]
    } catch {
      return null
    }
  })
}

/**
 * `18.4.0` → `18.4`.
 *
 * The exporter reports `short_version` with three segments; postgres numbers
 * its releases with two. Left alone, every comparison here is against a
 * version string that does not exist and the newest release always looks
 * newer than what is running.
 */
function twoSegments(v: string): string {
  const parts = v.trim().split('.')
  return parts.length >= 2 ? `${parts[0] ?? ''}.${parts[1] ?? ''}` : v.trim()
}

/**
 * Postgres release notes, from the docs page for one minor.
 *
 * The markup has been stable for years and is unusually regular: one `sect1`
 * per page, `sect2` per section, and each change is one `<li class="listitem">`
 * whose FIRST paragraph is the headline. The paragraphs after it are the
 * elaboration and the CVE attribution, which is exactly the detail the link at
 * the bottom of the entry is for — this panel answers "is there anything in
 * here for me".
 */
async function notesFor(version: string): Promise<ReleaseNote | null> {
  const url = `https://www.postgresql.org/docs/release/${version}/`

  return cached(`notes:${version}`, async () => {
    const html = await getText(url)
    if (html === null) return null

    const flat = html.replace(/\s+/g, ' ')
    const date = /Release date:(?:&nbsp;|\s)*<\/strong>\s*([\d-]+)/.exec(flat)?.[1] ?? ''

    const sections: ReleaseNote['sections'] = []
    let truncated = false

    // Split on the section divs and drop everything before the first one — the
    // page header and the table of contents, which repeats every heading and
    // would otherwise be parsed as a section with no items.
    for (const chunk of flat.split('<div class="sect2"').slice(1)) {
      const name = strip(/<h3 class="title">(.*?)<\/h3>/.exec(chunk)?.[1] ?? '')
        // "E.1.2. Changes" — the numbering is the docs appendix's, not the
        // release's, and it changes meaning every time a new minor is cut.
        .replace(/^E\.[\d.]+\s*/, '')
        .replace(/\s*#$/, '')
      if (name === '') continue

      const items = [...chunk.matchAll(/<li class="listitem">\s*<p>(.*?)<\/p>/g)]
        .map((m) => strip(m[1] ?? ''))
        .filter((s) => s.length > 2)

      // The Migration section is prose rather than a list — "a dump/restore is
      // not required", or the one sentence that says it IS. That is the most
      // load-bearing paragraph on the whole page, so it is read from the
      // paragraphs directly rather than dropped for having no bullets.
      const paras =
        items.length > 0 ? items : (
          [...chunk.matchAll(/<p>(.*?)<\/p>/g)].map((m) => strip(m[1] ?? '')).filter((s) => s.length > 2)
        )

      if (paras.length === 0) continue
      if (paras.length > MAX_ITEMS) truncated = true
      sections.push({ name, items: paras.slice(0, MAX_ITEMS) })
    }

    return { version, date, url, sections, truncated }
  })
}

/** Docs HTML → plain text. Only the markup these pages actually use. */
function strip(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#8212;/g, '—')
    .replace(/&quot;/g, '"')
    // The § that links each change to its commit — a link with no text once
    // the tags are gone, and it ends every single bullet. A change backed by
    // several commits carries one per commit, so this strips a RUN of them;
    // matching a single trailing § leaves "§ § § § § § § §" on the busiest
    // entries, which are the ones most worth reading.
    .replace(/(?:\s*§)+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * What is running, what is current, and the notes in between — for postgres.
 *
 * Deliberately confined to the running MAJOR. A major upgrade is a
 * `pg_upgrade`, a dump/restore or a logical replication cutover, and every
 * tenant on the cluster is offline for it; it is not the thing the word
 * "behind" means anywhere else on this dashboard, and quietly counting 19.x as
 * two releases pending would put a green-to-amber chip on a weekend of work.
 * The major that IS running, and its minors, are what a person can act on.
 */
export async function postgresGap(reported: string | null): Promise<VersionGap> {
  if (reported === null) return EMPTY_GAP

  const installed = twoSegments(reported)
  const major = installed.split('.')[0] ?? ''

  const list = await majors()
  if (list === null) {
    return {
      ...EMPTY_GAP,
      installed,
      note: 'postgresql.org did not answer — the version and its notes both come from there',
    }
  }

  const line = list.find((m) => m.major === major)
  if (line === undefined) {
    return {
      ...EMPTY_GAP,
      installed,
      note: `postgresql.org lists no ${major}.x release line — this cluster is on a major it no longer publishes`,
    }
  }

  const current = Number(line.latestMinor)
  const running = Number(installed.split('.')[1] ?? '0')
  const latest = `${major}.${line.latestMinor}`

  // Oldest first, matching how the upgrade chain reads everywhere else.
  const behind =
    Number.isFinite(current) && Number.isFinite(running) ?
      Array.from({ length: Math.max(0, current - running) }, (_, i) => `${major}.${String(running + i + 1)}`)
    : []

  // The running release is included so the panel says what you last got when
  // there is nothing pending, rather than going blank on a healthy cluster.
  const wanted = [...behind].reverse().concat(installed).slice(0, MAX_PAGES)
  const releases = (await Promise.all(wanted.map(notesFor))).filter(
    (r): r is ReleaseNote => r !== null,
  )

  return {
    installed,
    latest,
    behind,
    releases,
    // An out-of-support major is the one thing worse than being behind on
    // minors, and it is invisible from a version number alone: 16.10 looks
    // exactly as healthy as 18.4 until you know which lines still get fixes.
    note:
      !line.supported ?
        `PostgreSQL ${major} is out of support — postgresql.org publishes no further fixes for this line`
      : releases.length > 0 ? null
      : 'postgresql.org served the version list but not the release notes',
  }
}
