import type { Release } from '../../../components/release-notes'
import type { Ctx } from '../../../core/ctx'
import type { Commit, CommitGap } from '../../../lib/dashboard/github'
import { getJson } from '../../../lib/http'
import { decodeEntities } from '../../../lib/plain-text'

// What moving the Minecraft server's version would mean, and where it can go.
//
// Three vendors, three questions:
//
//   Mojang      what game the clients are on. A Java client joins only a
//               server of its own release, so Mojang moving past the pin is
//               the fact that locks people out — the warning on the page.
//               Its launcher feed carries each release's notes as HTML.
//   Paper       what this server CAN run. Paper follows Mojang by days or
//               weeks, and publishes each build on a channel: ALPHA and BETA
//               before STABLE. An ALPHA build is offered, because a server
//               nobody can join is its own failure, but only behind a typed
//               confirmation — Paper's own warning is that those can damage
//               a world, and a version bump converts the world for good.
//   the host    whether an update is running (host/version-update.ts).

const PAPER = 'https://fill.papermc.io/v3/projects/paper'
const PAPER_COMMIT = 'https://github.com/PaperMC/Paper/commit'
const MOJANG_NOTES = 'https://launchercontent.mojang.com/v2'

type PaperBuild = {
  id: number
  time: string
  channel: string
  commits?: { sha: string; time: string; message: string }[]
}

/** One place the page can move the server to. */
export type VersionOption = {
  version: string
  build: string
  channel: string
  /** Built on, `YYYY-MM-DD`. */
  date: string
  /** Anything short of STABLE/RECOMMENDED — the typed-confirmation kind. */
  preRelease: boolean
  /** A newer game than the pin, which converts the world one way. */
  newGame: boolean
}

export type MinecraftUpdate = {
  /** Mojang's newest release is past the pinned version. */
  mojangAhead: boolean
  /** What Paper has for Mojang's newest release, when that is past the pin. */
  paperForLatest: { stable: string | null; newest: { build: string; channel: string } | null }
  /** Newest first: the recommended move, then the rest. Empty = nowhere to go. */
  options: VersionOption[]
  /** Mojang's notes for every release after the pin up to its newest, newest first. */
  notes: Release[]
  /** Commits in the builds of the newest version offered, as the Changelog board takes them. */
  commits: CommitGap
}

const EMPTY_GAP: CommitGap = { running: null, builtOn: null, behind: [], note: null }

/** `26.3` / `1.21.11` — a release, not an rc or a pre. */
const RELEASE = /^\d+(\.\d+)+$/

/** Numeric, part by part: `26.10` is after `26.9`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

const isStable = (channel: string) => channel === 'STABLE' || channel === 'RECOMMENDED'

async function builds(version: string): Promise<PaperBuild[] | null> {
  const list = await getJson<PaperBuild[]>(
    `${PAPER}/versions/${encodeURIComponent(version)}/builds`,
  )
  return list === null ? null : [...list].sort((a, b) => b.id - a.id)
}

export async function loadMinecraftUpdate(
  _ctx: Ctx,
  pinned: { version: string | null; build: string | null },
  latestRelease: string | null,
): Promise<MinecraftUpdate> {
  const none: MinecraftUpdate = {
    mojangAhead: false,
    paperForLatest: { stable: null, newest: null },
    options: [],
    notes: [],
    commits: EMPTY_GAP,
  }
  const { version, build } = pinned
  if (version === null || build === null) return none

  const mojangAhead = latestRelease !== null && compareVersions(latestRelease, version) > 0
  const project = await getJson<{ versions?: Record<string, string[]> }>(PAPER)
  const newer = Object.values(project?.versions ?? {})
    .flat()
    .filter((v) => RELEASE.test(v) && compareVersions(v, version) > 0)
    .sort((a, b) => compareVersions(b, a))

  // The pinned version's newer builds, and every newer game's.
  const lists = await Promise.all(
    [version, ...newer].map(async (v) => [v, await builds(v)] as const),
  )

  const options: VersionOption[] = []
  let newestList: { version: string; builds: PaperBuild[] } | null = null
  for (const [v, list] of lists) {
    if (list === null || list.length === 0) continue
    const newGame = v !== version
    const eligible = newGame ? list : list.filter((b) => b.id > Number(build))
    const stable = eligible.find((b) => isStable(b.channel))
    const newest = eligible[0]
    const add = (b: PaperBuild) =>
      options.push({
        version: v,
        build: String(b.id),
        channel: b.channel,
        date: b.time.slice(0, 10),
        preRelease: !isStable(b.channel),
        newGame,
      })
    if (newest !== undefined && newest !== stable) add(newest)
    if (stable !== undefined) add(stable)
    if (newGame && newestList === null) newestList = { version: v, builds: list }
  }

  // Recommended first: the newest game that has a stable build, else a stable
  // build of the pinned game, else whatever is newest.
  const rank = (o: VersionOption) => (o.preRelease ? 1 : 0)
  options.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      compareVersions(b.version, a.version) ||
      Number(b.build) - Number(a.build),
  )

  const latestList =
    latestRelease === null ? null : (lists.find(([v]) => v === latestRelease)?.[1] ?? null)
  const paperForLatest = {
    stable:
      latestList === null
        ? null
        : (latestList.find((b) => isStable(b.channel))?.id.toString() ?? null),
    newest:
      latestList?.[0] === undefined
        ? null
        : { build: String(latestList[0].id), channel: latestList[0].channel },
  }

  const [notes, commits] = await Promise.all([
    mojangNotes(version, latestRelease),
    Promise.resolve(commitsOf(newestList)),
  ])

  return { mojangAhead, paperForLatest, options, notes, commits }
}

/** The commits in a version's builds, oldest first — Paper's changelog for it. */
function commitsOf(list: { version: string; builds: PaperBuild[] } | null): CommitGap {
  if (list === null) return EMPTY_GAP
  const behind: Commit[] = [...list.builds]
    .sort((a, b) => a.id - b.id)
    .flatMap((b) =>
      (b.commits ?? []).map((c) => ({
        sha: c.sha.slice(0, 7),
        date: c.time.slice(0, 10),
        subject: `#${String(b.id)} ${c.message.split('\n')[0] ?? ''}`,
        url: `${PAPER_COMMIT}/${c.sha}`,
      })),
    )
    .slice(-60)
  return { running: null, builtOn: null, behind, note: null }
}

// ── Mojang's release notes ────────────────────────────────────────────────
//
// The launcher's own feed: an index of every release and snapshot, each entry
// pointing at a JSON whose `body` is the notes as HTML. The HTML is shallow
// and regular — `<h1>`/`<h2>` headings over `<ul><li>` lists — so it reduces
// to the same sections-of-bullets shape the Factorio wiki gives, without a
// parser. Bullets are capped per section: 26.3's notes are 220 KB.

const NOTES_MAX_ITEMS = 12
const NOTES_MAX_SECTIONS = 14

type NotesIndex = {
  entries?: { version?: string; type?: string; date?: string; contentPath?: string; id?: string }[]
}

async function mojangNotes(pinned: string, latest: string | null): Promise<Release[]> {
  if (latest === null || compareVersions(latest, pinned) <= 0) return []
  const index = await getJson<NotesIndex>(`${MOJANG_NOTES}/javaPatchNotes.json`)
  const wanted = (index?.entries ?? [])
    .filter(
      (e) =>
        e.type === 'release' &&
        typeof e.version === 'string' &&
        RELEASE.test(e.version) &&
        compareVersions(e.version, pinned) > 0 &&
        compareVersions(e.version, latest) <= 0 &&
        typeof e.contentPath === 'string',
    )
    .sort((a, b) => compareVersions(b.version ?? '', a.version ?? ''))
    .slice(0, 4)

  const bodies = await Promise.all(
    wanted.map((e) =>
      getJson<{ body?: string }>(`${MOJANG_NOTES}/${e.contentPath ?? ''}`, {}, [4_000, 8_000]),
    ),
  )
  return wanted.map((e, i) => {
    const { sections, truncated } = htmlSections(bodies[i]?.body ?? '')
    return {
      version: e.version ?? '',
      date: (e.date ?? '').slice(0, 10),
      // The wiki names a release's page by its number, which the article
      // slugs on minecraft.net do not reliably follow.
      url: `https://minecraft.wiki/w/Java_Edition_${e.version ?? ''}`,
      sections,
      truncated,
    }
  })
}

const text = (html: string) =>
  decodeEntities(html.replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim()

/** `<h1>`/`<h2>` headings over `<li>` bullets → sections of plain-text items. */
export function htmlSections(html: string): {
  sections: Release['sections']
  truncated: boolean
} {
  const parts = html.split(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/i)
  const sections: Release['sections'] = []
  let truncated = false
  for (let i = 1; i < parts.length; i += 2) {
    const name = text(parts[i] ?? '')
    const items = [...(parts[i + 1] ?? '').matchAll(/<li[^>]*>([\s\S]*?)(?=<li|<\/li>|<\/ul>|$)/gi)]
      .map((m) => text(m[1] ?? ''))
      .filter((s) => s !== '')
    if (name === '' || items.length === 0) continue
    if (items.length > NOTES_MAX_ITEMS) truncated = true
    sections.push({ name, items: items.slice(0, NOTES_MAX_ITEMS) })
  }
  if (sections.length > NOTES_MAX_SECTIONS) truncated = true
  return { sections: sections.slice(0, NOTES_MAX_SECTIONS), truncated }
}
