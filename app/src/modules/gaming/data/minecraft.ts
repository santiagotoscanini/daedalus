import type { Ctx } from '../../../core/ctx'
import type { ImageUpdateStatus } from '../../../host/image-update'
import type { VersionUpdateStatus } from '../../../host/version-update'
import type { Commit, CommitGap } from '../../../lib/dashboard/github'
import type { UpdateRow } from '../../../lib/dashboard/update-rows'
import { getJson } from '../../../lib/http'
import { loadMinecraftUpdate, type MinecraftUpdate } from './minecraft-update'
import { wanHost } from './shared'

// The Minecraft tab: the Paper server — live from the server-list ping, what a
// re-pull would bring, who may join and who came, and the update decisions.
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

export type MinecraftData = {
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
  /**
   * Who may join: site.json `modules.players.minecraft`, committed and as the
   * next Apply would write it, one row per account in either. `state` is
   * where the row stands against the committed file; `opPending` is an op
   * change the Apply has not made yet.
   */
  roster: {
    name: string
    uuid: string
    op: boolean
    state: 'applied' | 'adding' | 'removing'
    opPending: boolean
    /** Mojang's name for the uuid now, when it is not the one on the list. */
    renamed: string | null
    model: 'slim' | 'classic' | null
    cape: boolean
    head: string | null
    /** ms — the newest join in the last 30 days, else null. */
    lastSeen: number | null
  }[]
  /** Where the game version can go, and what Mojang shipped since (data/minecraft-update.ts). */
  update: MinecraftUpdate
  /** The version-update bridge, so a page opened mid-update joins the run. */
  versionStatus: VersionUpdateStatus
  /** The stack's two containers as update decisions — the server image and its exporter. */
  images: UpdateRow[]
  imageStatus: ImageUpdateStatus
}

/** The containers this tab answers for, image-wise. */
const MINECRAFT_CONTAINERS = ['minecraft', 'minecraft-monitor'] as const

const PAPER_API = 'https://fill.papermc.io/v3/projects/paper'
const PAPER_REPO = 'https://github.com/PaperMC/Paper/commit'
const MC_PORT = 25565

export async function loadMinecraft(ctx: Ctx): Promise<MinecraftData> {
  const version = ctx.env('MINECRAFT_VERSION') ?? null
  const build = ctx.env('MINECRAFT_PAPER_BUILD') ?? null

  const { readVersionUpdateStatus } = await import('../../../host/version-update')
  const { readImageUpdateStatus } = await import('../../../host/image-update')
  const { updateRows } = await import('../../../lib/dashboard/update-rows')
  const [
    live,
    online,
    reported,
    latestVersion,
    builds,
    events,
    roster,
    versionStatus,
    images,
    imageStatus,
  ] = await Promise.all([
    ctx.prom.scalars({
      healthy: 'max(minecraft_status_healthy)',
      players: 'max(minecraft_status_players_online_count)',
      maxPlayers: 'max(minecraft_status_players_max_count)',
      ping: 'max(minecraft_status_response_time_seconds)',
    }),
    // 24h at the exporter's own resolution. Asking for finer just interpolates
    // the same samples — see promSeries.
    ctx.prom.series('max(minecraft_status_players_online_count)', 24 * 60, 300),
    reportedVersion(ctx),
    latestRelease(),
    paperBuilds(version, build),
    joinsAndLeaves(ctx),
    minecraftRoster(ctx),
    readVersionUpdateStatus(),
    updateRows(MINECRAFT_CONTAINERS),
    readImageUpdateStatus(),
  ])
  // After the rest: it needs Mojang's newest release, which the batch above read.
  const update = await loadMinecraftUpdate(ctx, { version, build }, latestVersion)

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
      connect: `${wanHost(ctx)}:${String(MC_PORT)}`,
    },
    builds,
    events,
    roster,
    update,
    versionStatus,
    images,
    imageStatus,
  }
}

/**
 * The roster, with what Mojang and the log say about each account.
 *
 * The last join is its own Loki read over 30 days — the events panel's week
 * is too short to answer "has this person ever come". Failure anywhere is
 * a thinner row, never a missing one: the list itself comes from the site
 * document, which is always readable.
 */
async function minecraftRoster(ctx: Ctx): Promise<MinecraftData['roster']> {
  const { profileOf, roster } = await import('../../../core/site/players')
  const [{ committed, desired }, joins] = await Promise.all([
    roster(ctx, 'minecraft'),
    ctx.loki.entries('{stack="minecraft"} |= "joined the game"', 60 * 24 * 30, 200),
  ])

  const lastJoin = new Map<string, number>()
  for (const { at, line } of joins) {
    const who = /:\s*(\w{1,16})\s+joined the game/.exec(line)?.[1]?.toLowerCase()
    if (who !== undefined && at > (lastJoin.get(who) ?? 0)) lastJoin.set(who, at)
  }

  const was = new Map(committed.map((p) => [p.uuid, p]))
  const will = new Set(desired.map((p) => p.uuid))
  const rows = [
    ...desired.map((p) => ({
      p,
      state: was.has(p.uuid) ? ('applied' as const) : ('adding' as const),
      opPending: was.has(p.uuid) && was.get(p.uuid)?.op !== p.op,
    })),
    ...committed
      .filter((p) => !will.has(p.uuid))
      .map((p) => ({ p, state: 'removing' as const, opPending: false })),
  ]

  const profiles = await Promise.all(rows.map((r) => profileOf(r.p.uuid)))
  return rows
    .map(({ p, state, opPending }, i) => {
      const prof = profiles[i] ?? null
      const now = prof?.name ?? null
      return {
        name: p.name,
        uuid: p.uuid,
        op: p.op,
        state,
        opPending,
        renamed: now !== null && now !== p.name ? now : null,
        model: prof?.model ?? null,
        cape: prof?.cape ?? false,
        head: prof?.head ?? null,
        lastSeen:
          lastJoin.get(p.name.toLowerCase()) ??
          (now === null ? null : (lastJoin.get(now.toLowerCase()) ?? null)),
      }
    })
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
}

/**
 * The version string the server puts in its own ping response.
 *
 * mc-monitor carries it as a label rather than a value, so this reads the
 * series' labels instead of its number. Paper answers with its own
 * decoration around the version ("Paper 26.2"), which is left alone — it is
 * what the server said, and tidying it would be inventing a fact.
 */
async function reportedVersion(ctx: Ctx): Promise<string | null> {
  const r = await ctx.prom.vector('minecraft_status_healthy')
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
async function joinsAndLeaves(ctx: Ctx): Promise<MinecraftData['events']> {
  const lines = await ctx.loki.entries(
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
