// The Gaming category — two game servers, asked the same three questions.
//
// Its own page rather than a corner of Home because the questions are its
// own: which version is running, can the clients on the sofa still join it,
// and what has the vendor shipped since.
//
// The two tabs answer those from opposite ends. Factorio has an admin UI and
// no way to be asked anything by a machine, so everything here comes from the
// vendor and the pin. Minecraft has no admin UI at all and answers the
// server-list ping, so its numbers are live — how many people are on right
// now, and how long the server took to say so.
//
// ── where the version facts come from ─────────────────────────────────────
//
// ofsm does not manage the game version. It downloads exactly
// $FACTORIO_VERSION on every container start, so the string pinned in
// stacks/factorio/factorio.nix IS the running version — it reaches this file
// through the container env rather than being read back off the server, which
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

import { getJson } from '../../http'
import { lokiEntries } from '../../loki'
import { promScalars, promSeries, promVector } from '../../prom'
import type { Commit, CommitGap } from '../github'

/**
 * One shape per sub-tab. A union rather than optional fields, so the
 * Minecraft tab cannot accidentally read a Factorio number that is not there.
 */
export type GamingData =
  | ({ tab: 'factorio' } & FactorioData)
  | ({ tab: 'minecraft' } & MinecraftData)

type FactorioData = {
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

/**
 * The name both game servers are reached by, from anywhere.
 *
 * Not a literal: pi-hole answers it with the LAN address and Cloudflare with
 * the WAN one, which is the whole reason there is a single address to print.
 * See platform/ddclient. Read from the env rather than retyped here, because
 * a second copy of a hostname is a second copy that goes stale.
 */
const wanHost = () => process.env.WAN_HOST ?? ''

export async function loadGaming(
  tab: string,
  ctx: { base: (app: string) => string },
): Promise<GamingData> {
  if (tab === 'minecraft') return { tab: 'minecraft', ...(await loadMinecraft()) }
  return { tab: 'factorio', ...(await loadFactorio(ctx)) }
}

async function loadFactorio(ctx: { base: (app: string) => string }): Promise<FactorioData> {
  const installed = process.env.FACTORIO_VERSION ?? null

  const [releases, graph, feed] = await Promise.all([
    getJson<{ stable?: { headless?: string }; experimental?: { headless?: string } }>(
      'https://factorio.com/api/latest-releases',
    ),
    getJson<Record<string, ({ from?: string; to?: string } & { stable?: string })[]>>(
      'https://updater.factorio.com/get-available-versions',
    ),
    fetchFeed(),
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
      connect: `${wanHost()}:${String(PORT)}`,
      port: PORT,
      adminUrl: ctx.base('factorio-admin'),
    },
    news: feed,
    changelog,
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
          title: decode(title),
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

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
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

// ── Minecraft ──────────────────────────────────────────────────────────────
//
// Three sources, and which one answers which question is the whole design:
//
//   prometheus   what is true right now — mc-monitor speaks the server-list
//                ping, so `healthy` means the game answered, not that a
//                container exists. A wedged JVM reads as down here and as up
//                everywhere else.
//   fill.papermc what a re-pull would bring. Paper publishes its builds with
//                the commits in each one, which IS a changelog — and the
//                commits carry SHAs, so every line links to the real commit
//                rather than to a page invented from a build number.
//   launchermeta whether Mojang has moved past the pinned version at all.
//                Two versions behind Paper's newest BUILD is routine; being
//                behind on the game is what stops clients joining.
//
// The pinned strings come from the container env because the image downloads
// exactly them on start — so, as with Factorio, the pin is the running
// version rather than a record of it.

type MinecraftData = {
  minecraft: {
    /** Pinned in nix, downloaded on every container start — so, running. */
    version: string | null
    build: string | null
    /**
     * What the server itself said in the ping handshake. Read separately from
     * the pin on purpose: the two disagreeing is the shape of a container that
     * never restarted after the version was bumped.
     */
    reported: string | null
    /** Mojang's newest release, whatever this box is on. */
    latestVersion: string | null
    /** Answered the ping. Null when prometheus has no sample at all. */
    healthy: boolean | null
    players: number | null
    maxPlayers: number | null
    /** Status-ping round trip, seconds. */
    ping: number | null
    /** Players online over the last day, for a sparkline. */
    online: number[]
    /** The one address that works from anywhere. */
    connect: string
  }
  /** Paper builds newer than the pinned one, as commits. */
  builds: CommitGap
  /** Who came and went, newest first. */
  events: { at: number; who: string; kind: 'join' | 'leave' }[]
}

const PAPER_API = 'https://fill.papermc.io/v3/projects/paper'
const PAPER_REPO = 'https://github.com/PaperMC/Paper/commit'
const MC_PORT = 25565

async function loadMinecraft(): Promise<MinecraftData> {
  const version = process.env.MINECRAFT_VERSION ?? null
  const build = process.env.MINECRAFT_PAPER_BUILD ?? null

  const [live, online, reported, latestVersion, builds, events] = await Promise.all([
    promScalars({
      healthy: 'max(minecraft_status_healthy)',
      players: 'max(minecraft_status_players_online_count)',
      maxPlayers: 'max(minecraft_status_players_max_count)',
      ping: 'max(minecraft_status_response_time_seconds)',
    }),
    // 24h at the exporter's own resolution. Asking for finer just interpolates
    // the same samples — see promSeries.
    promSeries('max(minecraft_status_players_online_count)', 24 * 60, 300),
    reportedVersion(),
    latestRelease(),
    paperBuilds(version, build),
    joinsAndLeaves(),
  ])

  return {
    minecraft: {
      version,
      build,
      reported,
      latestVersion,
      // A missing series is "we could not ask", which is not the same as "the
      // server is down" and must not be drawn as it.
      healthy: live.healthy === null ? null : live.healthy >= 1,
      players: live.players,
      maxPlayers: live.maxPlayers,
      ping: live.ping,
      online,
      connect: `${wanHost()}:${String(MC_PORT)}`,
    },
    builds,
    events,
  }
}

/**
 * The version string the server puts in its own ping response.
 *
 * mc-monitor carries it as a label rather than a value, so this reads the
 * series' labels instead of its number. Paper answers with its own
 * decoration around the version ("Paper 26.2"), which is left alone — it is
 * what the server said, and tidying it would be inventing a fact.
 */
async function reportedVersion(): Promise<string | null> {
  const r = await promVector('minecraft_status_healthy')
  return r[0]?.metric.server_version ?? null
}

/** Mojang's own idea of current. One field, from the launcher's manifest. */
async function latestRelease(): Promise<string | null> {
  const body = await getJson<{ latest?: { release?: string } }>(
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
  )
  return body?.latest?.release ?? null
}

/**
 * Paper builds published after the one pinned, flattened to their commits.
 *
 * Shaped as a CommitGap so it renders through the same Changelog panel the
 * branch-tracking images use, which is the honest comparison: Paper cuts a
 * build per handful of commits, so "three builds behind" means nothing on its
 * own and the commit subjects mean everything.
 *
 * Ordered oldest-first to match what that panel expects.
 */
async function paperBuilds(version: string | null, build: string | null): Promise<CommitGap> {
  const empty: CommitGap = { running: build, builtOn: null, behind: [], note: null }
  if (version === null || build === null) return empty

  const list = await getJson<
    {
      id: number
      time: string
      channel: string
      commits?: { sha: string; time: string; message: string }[]
    }[]
  >(`${PAPER_API}/versions/${encodeURIComponent(version)}/builds`)

  if (list === null) {
    return { ...empty, note: 'Could not reach the PaperMC build API.' }
  }

  const pinned = Number(build)
  const running = list.find((b) => b.id === pinned)

  const behind: Commit[] = list
    // STABLE only: experimental builds are not what this server is pinned to
    // follow, and listing them would count a gap that does not exist.
    .filter((b) => b.id > pinned && b.channel === 'STABLE')
    .sort((a, b) => a.id - b.id)
    .flatMap((b) =>
      (b.commits ?? []).map((c) => ({
        sha: c.sha.slice(0, 7),
        date: c.time.slice(0, 10),
        // Paper commit messages are a subject line and then a body explaining
        // it; the subject is the part that fits on a row.
        subject: c.message.split('\n')[0] ?? '',
        url: `${PAPER_REPO}/${c.sha}`,
      })),
    )

  return {
    running: build,
    builtOn: running?.time.slice(0, 10) ?? null,
    behind,
    note:
      running === undefined
        ? 'The pinned build is not in Paper’s list for this version — it may have aged out.'
        : null,
  }
}

/**
 * Arrivals and departures, from the server's own log.
 *
 * Paper writes one line per event in a fixed shape, so this reads Loki rather
 * than holding a player list of its own — the log is already the record, and a
 * second one could only be wrong. Failure is empty: this panel is the least
 * important thing on the page and must not cost it.
 */
async function joinsAndLeaves(): Promise<MinecraftData['events']> {
  const lines = await lokiEntries(
    '{stack="minecraft"} |~ "(joined|left) the game"',
    60 * 24 * 7,
    30,
  )

  return lines
    .map(({ at, line }) => {
      const m = /:\s*(\w{3,16})\s+(joined|left) the game/.exec(line)
      if (m === null) return null
      return {
        at,
        who: m[1] ?? '',
        kind: m[2] === 'joined' ? ('join' as const) : ('leave' as const),
      }
    })
    .filter((e): e is MinecraftData['events'][number] => e !== null)
}
