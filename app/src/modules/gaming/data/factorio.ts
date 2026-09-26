import type { Ctx } from '../../../core/ctx'
import { getJson } from '../../../lib/http'
import { decodeEntities } from '../../../lib/plain-text'
import { wanHost } from './shared'

// The Factorio tab: the pinned version against Wube's, the game's own
// lifecycle and joins from its log, the devs' feed and the wiki's notes.
//
// ── where the version facts come from ─────────────────────────────────────
//
// ofsm does not manage the game version. It downloads exactly
// $FACTORIO_VERSION on every container start, so the string pinned in
// nix/modules/factorio/factorio.nix IS the running version — it reaches this file
// through daedalus's own env rather than being read back off the server, which
// has no unauthenticated endpoint to read it from anyway.
//
// Everything about what is CURRENT comes from Wube, unauthenticated:
//
//   /api/latest-releases          stable + experimental, per build
//   updater.../get-available-versions
//                                 the whole upgrade graph, which is what lets
//                                 this count the releases between the pinned
//                                 version and stable rather than just saying
//                                 "newer exists"
//   /blog/rss                     the devs' own feed: release announcements
//                                 and Friday Facts, which is the closest thing
//                                 to a changelog that is machine-readable

export type FactorioData = {
  factorio: {
    /** Pinned in nix, downloaded on every container start — so, running. */
    installed: string | null
    stable: string | null
    experimental: string | null
    /** Releases between `installed` and `stable`, oldest first. */
    behind: string[]
    /** How the game is reached, which is not through traefik. */
    connect: string
    port: number
    /** Where the manager lives. LAN only — deliberately not forwarded. */
    adminUrl: string
  }
  /**
   * What is live here and what is not, and why the split sits where it does.
   *
   * ofsm holds RCON entirely to itself — the interface is opened inside the
   * netns on a random port, nothing publishes it, and daedalus holds no ofsm
   * credential — so there is no live player COUNT without new nix-side wiring.
   * But the game states its own lifecycle in its log: ofsm prints one line
   * when it starts the server and one when it stops it, and Loki already has
   * both. That answers the question the tab's dot cannot — the dot reads the
   * manager's UI, which keeps answering happily while the game inside it is
   * shut down.
   */
  live: {
    /** container_up — the ofsm container, which outlives the game it runs. */
    containerUp: boolean | null
    /** The newest lifecycle line wins. null = none in the 30-day window. */
    game: 'running' | 'stopped' | null
    /** ms — when that line was logged. */
    since: number | null
  }
  /** Who came and went, newest first — same record Minecraft reads. */
  events: { at: number; who: string; kind: 'join' | 'leave' }[]
  /** The devs' feed — release posts and Friday Facts, newest first. */
  news: { title: string; url: string; date: string; kind: 'release' | 'fff' | 'post' }[]
  /**
   * Per-release notes, newest first. The releases between installed and
   * stable when there are any; otherwise the one that is running, so the
   * panel says what you last got rather than nothing.
   */
  changelog: {
    version: string
    date: string
    /** Where the full notes live — see `wikiUrl`. */
    url: string
    sections: { name: string; items: string[] }[]
    /** True when the section lists were cut — see CHANGELOG_MAX_ITEMS. */
    truncated: boolean
  }[]
}

/**
 * Where a release actually lives on the wiki.
 *
 * There is no page per release. `Version_history/2.1.12` is a red link —
 * every 2.1.x lives as a SECTION of `Version_history/2.1.0`, and the version
 * number is the heading, so the anchor is what lands you on the right one.
 *
 * Resolved on the server so the payload carries a URL per entry, which is what
 * lets the shared release-notes component render this and the GitHub-sourced
 * changelogs on the AI pages without knowing where either came from.
 */
function wikiUrl(version: string): string {
  const [maj, min] = version.split('.')
  const series = maj !== undefined && min !== undefined ? `${maj}.${min}.0` : version
  return `https://wiki.factorio.com/Version_history/${series}#${version}`
}

/**
 * Bullets kept per release.
 *
 * A Factorio point release runs to 40-odd fixes and this payload is
 * serialised into the page's HTML for hydration. Ten is enough to answer "is
 * there anything in here I care about", and the version heading links to the
 * full page for when the answer is yes.
 */
const CHANGELOG_MAX_ITEMS = 10

const PORT = 34197

export async function loadFactorio(ctx: Ctx): Promise<FactorioData> {
  const installed = ctx.env('FACTORIO_VERSION') ?? null

  const [releases, graph, feed, containerUp, gameLog] = await Promise.all([
    getJson<{ stable?: { headless?: string }; experimental?: { headless?: string } }>(
      'https://factorio.com/api/latest-releases',
    ),
    getJson<Record<string, ({ from?: string; to?: string } & { stable?: string })[]>>(
      'https://updater.factorio.com/get-available-versions',
    ),
    fetchFeed(),
    ctx.prom.scalar('container_up{name="factorio"}'),
    gameLines(ctx),
  ])

  const stable = releases?.stable?.headless ?? null
  const experimental = releases?.experimental?.headless ?? null
  const behind = chain(graph?.['core-linux_headless64'] ?? [], installed, stable)

  // Fetched only for the releases actually shown. Nothing behind means the
  // one running, which keeps the panel useful rather than empty.
  const wanted = behind.length > 0 ? behind : installed === null ? [] : [installed]
  const changelog = await fetchChangelog(wanted)

  return {
    factorio: {
      installed,
      stable,
      experimental,
      behind,
      // NOT the admin hostname: the game speaks its own UDP protocol straight
      // to the router-forwarded port and never touches traefik. The DDNS name
      // tracks this house's WAN address AND is short-circuited to the LAN
      // address by pi-hole, so this one string is what every player types,
      // wherever they are sitting.
      connect: `${await wanHost()}:${String(PORT)}`,
      port: PORT,
      adminUrl: ctx.hosts.base('factorio-admin'),
    },
    live: {
      containerUp: containerUp === null ? null : containerUp >= 1,
      game: gameLog.state,
      since: gameLog.since,
    },
    events: gameLog.events,
    news: feed,
    changelog,
  }
}

/**
 * Everything the game says about itself, in one Loki query.
 *
 * One rather than two on purpose — Loki's budget is a single patient attempt
 * (host/loki.ts), so lifecycle and joins ride the same line filter and are told
 * apart here. The shapes are ofsm's and the game's own:
 *
 *   Factorio server with save: … started on port: 34197     (ofsm)
 *   Factorio server stopped                                  (ofsm)
 *   [JOIN] name joined the game / [LEAVE] name left the game (the game)
 *
 * The current state is the newest lifecycle line. A window with none means the
 * question cannot be answered from here — reported as null, not guessed from
 * the container gauge, because ofsm idling with no game is exactly the case
 * this read exists to catch.
 */
async function gameLines(ctx: Ctx): Promise<{
  state: 'running' | 'stopped' | null
  since: number | null
  events: FactorioData['events']
}> {
  const lines = await ctx.loki.entries(
    '{stack="factorio"} |~ "\\\\[(JOIN|LEAVE)\\\\]|started on port|Factorio server stopped"',
    60 * 24 * 30,
    60,
  )

  const lifecycle = lines.find(
    (l) => l.line.includes('started on port') || l.line.includes('server stopped'),
  )

  return {
    state:
      lifecycle === undefined
        ? null
        : lifecycle.line.includes('started on port')
          ? 'running'
          : 'stopped',
    since: lifecycle?.at ?? null,
    events: lines
      .map(({ at, line }) => {
        const m = /\[(JOIN|LEAVE)\]\s+(\S+)/.exec(line)
        if (m === null) return null
        return {
          at,
          who: m[2] ?? '',
          kind: m[1] === 'JOIN' ? ('join' as const) : ('leave' as const),
        }
      })
      .filter((e): e is FactorioData['events'][number] => e !== null),
  }
}

/**
 * The releases between what is installed and what is stable.
 *
 * Wube publishes the upgrade graph as `{from, to}` pairs, which is exactly a
 * linked list — walking it gives the real sequence rather than a numeric
 * comparison, so a version that was pulled shows up as a gap rather than as a
 * wrong count. Bounded at 40 hops so a badly-pinned version cannot spin.
 */
function chain(
  pairs: ({ from?: string; to?: string } & { stable?: string })[],
  from: string | null,
  to: string | null,
): string[] {
  if (from === null || to === null || from === to) return []
  const next = new Map<string, string>()
  for (const p of pairs) {
    if (p.from !== undefined && p.to !== undefined) next.set(p.from, p.to)
  }
  const out: string[] = []
  let at = from
  for (let i = 0; i < 40; i++) {
    const step = next.get(at)
    if (step === undefined) break
    out.push(step)
    if (step === to) return out
    at = step
  }
  // Ran off the end of the graph without reaching stable: report the target
  // alone rather than a chain that does not actually lead there.
  return [to]
}

/**
 * factorio.com/blog/rss, parsed with regexes rather than an XML dependency.
 *
 * The feed is small, fixed-shape Atom from one publisher. A parser would be a
 * dependency in a container that reparses its whole module graph on a cold
 * load, to read three fields.
 */
async function fetchFeed(): Promise<FactorioData['news']> {
  try {
    const res = await fetch('https://factorio.com/blog/rss', {
      signal: AbortSignal.timeout(4_000),
    })
    if (!res.ok) return []
    const xml = await res.text()

    return [...xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g)]
      .map((m) => {
        const body = m[1] ?? ''
        const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(body)?.[1]?.trim() ?? ''
        const url = /<link[^>]*href="([^"]+)"/.exec(body)?.[1] ?? 'https://factorio.com/blog'
        const date = (/<updated>([^<]+)<\/updated>/.exec(body)?.[1] ?? '').slice(0, 10)
        return {
          title: decodeEntities(title),
          url,
          date,
          // A release post is the one entry type that is actually a changelog,
          // so it is worth telling apart from a Friday Facts.
          kind: /version\s+\d|released/i.test(title)
            ? ('release' as const)
            : /friday facts/i.test(title)
              ? ('fff' as const)
              : ('post' as const),
        }
      })
      .filter((e) => e.title !== '')
      .slice(0, 6)
  } catch {
    return []
  }
}

/**
 * Release notes for specific versions, from the wiki.
 *
 * Wube keeps one page per minor series (`Version_history/2.0.0` holds every
 * 2.0.x) and MediaWiki will hand over its source, which is far better than
 * scraping the rendered HTML: the wikitext is a stable, tiny grammar —
 *
 *   == 2.0.77 ==
 *   Date: 21.05.2026
 *   === Bugfixes ===
 *   * Fixed a clipping issue ... ([https://forums.factorio.com/131012 more])
 *
 * — so the parse is three regexes rather than a DOM walk that breaks the next
 * time someone restyles the page.
 *
 * Wanted versions are grouped by series so a request that straddles a boundary
 * (2.0.x → 2.1.x) fetches two pages instead of guessing one. Failure is empty,
 * like everything else here: the wiki being down must not cost the page.
 */
async function fetchChangelog(versions: string[]): Promise<FactorioData['changelog']> {
  if (versions.length === 0) return []

  // `2.0.77` → `2.0.0`, the page that holds the whole series.
  const seriesOf = (v: string) => {
    const [maj, min] = v.split('.')
    return maj !== undefined && min !== undefined ? `${maj}.${min}.0` : null
  }
  const series = [...new Set(versions.map(seriesOf).filter((s): s is string => s !== null))]

  const pages = await Promise.all(series.map(fetchSeries))
  const found = new Map<string, FactorioData['changelog'][number]>()
  for (const page of pages) {
    for (const entry of page) found.set(entry.version, entry)
  }

  // Newest first, and only the versions asked for — the page holds hundreds.
  return versions
    .map((v) => found.get(v))
    .filter((e): e is FactorioData['changelog'][number] => e !== undefined)
    .reverse()
}

async function fetchSeries(series: string): Promise<FactorioData['changelog']> {
  const url =
    'https://wiki.factorio.com/api.php?action=parse&format=json&formatversion=2' +
    `&prop=wikitext&page=${encodeURIComponent(`Version_history/${series}`)}`

  const body = await getJson<{ parse?: { wikitext?: string } }>(url, {}, [12_000])
  const wikitext = body?.parse?.wikitext
  if (typeof wikitext !== 'string') return []

  const out: FactorioData['changelog'] = []
  // Split on the version headings; `==` at line start is unambiguous here
  // because every deeper heading uses three or more.
  const blocks = wikitext.split(/^==\s*([0-9]+\.[0-9]+\.[0-9]+)\s*==\s*$/m)

  // split() with one capture group yields [preamble, ver, body, ver, body, …].
  for (let i = 1; i < blocks.length; i += 2) {
    const version = blocks[i]
    const body = blocks[i + 1]
    if (version === undefined || body === undefined) continue

    const date = /^Date:\s*(.+)$/m.exec(body)?.[1]?.trim() ?? ''
    const sections: { name: string; items: string[] }[] = []
    let truncated = false

    const parts = body.split(/^===\s*([^=\n]+?)\s*===\s*$/m)
    for (let j = 1; j < parts.length; j += 2) {
      const name = parts[j]
      const chunk = parts[j + 1]
      if (name === undefined || chunk === undefined) continue
      const all = [...chunk.matchAll(/^\*\s+(.+)$/gm)].map((m) => clean(m[1] ?? ''))
      if (all.length > CHANGELOG_MAX_ITEMS) truncated = true
      sections.push({ name, items: all.slice(0, CHANGELOG_MAX_ITEMS) })
    }

    out.push({ version, date, url: wikiUrl(version), sections, truncated })
  }
  return out
}

/** Wikitext → plain text. Only the markup Wube actually uses in changelogs. */
function clean(s: string): string {
  return (
    s
      // [url label] → label, and a bare [url] → nothing worth showing.
      .replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1')
      .replace(/\[https?:\/\/\S+\]/g, '')
      .replace(/\[\[[^|\]]*\|([^\]]*)\]\]/g, '$1')
      .replace(/\[\[([^\]]*)\]\]/g, '$1')
      .replace(/'''([^']*)'''/g, '$1')
      .replace(/''([^']*)''/g, '$1')
      // `([https://forums.factorio.com/131012 more])` becomes `(more)` once the
      // URL is gone — a parenthesis around a word that no longer links
      // anywhere. Drop it rather than ship dead furniture.
      .replace(/\s*\(\s*more\s*\)\s*$/i, '')
      .replace(/\s*\(\s*\)\s*$/, '')
      .trim()
  )
}
