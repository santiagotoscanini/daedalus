// The Media category: a tab per JOB, in the order a file travels, and a switch
// inside the page for the services that share one.
//
// This replaced a two-tab page (a pipeline diagram, then a directory of eleven
// tiles) and the reason is what a tile could never hold. Every service here is
// a pinned image that is never automatically up to date — CLAUDE.md's
// `--pull missing` note applies to all of them — and every one of them has its
// own idea of whether it is healthy. Three stats and a link could not say
// either thing, so eleven services shared one page on which nothing was
// answerable and nine of them were a number nobody had asked for.
//
// ── what every service page owes the reader ───────────────────────────────
//
// The same three things, in the same place: what version is running and what
// is between it and current, what the service itself says is wrong, and its
// log — with the logs of any container that has nowhere else to be read folded
// underneath. flaresolverr, subgen and scraparr are on this page for exactly
// that reason: each is a plausible answer to "it failed and its own log blamed
// its upstream", none has an API this box can reach, and so none has a page.
//
// ── where a number comes from ─────────────────────────────────────────────
//
// The service's own API, wherever it will answer. Prometheus is used only for
// what no API can say — a month of disk growth — and Loki only for the three
// services that publish no numbers at all. This is the opposite of the old
// page's rule, and the reason is that these panels are read WHILE something is
// wrong: scraparr's copy of a queue depth is up to a minute old, which is a
// minute of watching a stalled import that already cleared.

import {
  getJson,
  getText,
  lokiEntries,
  lokiLatest,
  lokiScalar,
  pool,
  promScalars,
  promSeries,
  qbtCookie,
} from '../clients'
import { key } from '../format'
import { versionGap, type VersionGap } from '../github'
import { imageTag, imageVersion, type RunningVersion } from '../images'

/**
 * A tab is a JOB; the services doing it are a switch inside the page.
 *
 * Seven tabs rather than the sixteen containers behind them, because several
 * of those containers are one job split across processes for historical
 * reasons rather than for the reader's. Seerr, Sonarr and Radarr answer one
 * question — what should be here that isn't. qBittorrent, NZBGet and MeTube
 * answer another — what is coming down the wire. Giving each of them a tab
 * made the reader reassemble a job the software had already split.
 *
 * The same shape the Network category uses for its three ways in: the tab is
 * the subject, the switch picks which implementation of it you are looking at,
 * and each option carries its own health dot so the choice is informed before
 * it is made.
 *
 * A service earns a switch option by having a PAGE — something to say beyond
 * its log. flaresolverr, subgen and scraparr have no reachable API at all, so
 * they stay folded under the log of the tab they serve.
 */
export type MediaData =
  | ({ tab: 'jellyfin' } & JellyfinData)
  | ({ tab: 'calibre' } & CalibreData)
  | {
      tab: 'wanted'
      seerr: SeerrData
      sonarr: ArrData
      radarr: ArrData
      recyclarr: RecyclarrData
      bazarr: BazarrData
    }
  | ({ tab: 'indexer' } & ProwlarrData)
  | ({ tab: 'downloaders' } & DownloadsData)
  | ({ tab: 'cleanup' } & CleanupData)

type Ctx = { base: (app: string) => string; hc: string }

export async function loadMedia(tab: string, ctx: Ctx): Promise<MediaData> {
  switch (tab) {
    case 'calibre':
      return { tab: 'calibre', ...(await loadCalibre(ctx)) }
    case 'wanted': {
      // All five, because all five are on the page — the switch chooses what
      // is SHOWN, not what is fetched. Fetching on selection would put a
      // spinner behind a button that is meant to feel like a toggle.
      const [seerr, sonarr, radarr, recyclarr, bazarr] = await Promise.all([
        loadSeerr(ctx.base('seerr')),
        loadArr('sonarr', ctx),
        loadArr('radarr', ctx),
        loadRecyclarr(),
        loadBazarr(ctx),
      ])
      return { tab: 'wanted', seerr, sonarr, radarr, recyclarr, bazarr }
    }
    case 'indexer':
      return { tab: 'indexer', ...(await loadProwlarr(ctx)) }
    case 'downloaders':
      return { tab: 'downloaders', ...(await loadDownloads(ctx)) }
    case 'cleanup':
      return { tab: 'cleanup', ...(await loadCleanup()) }
    default:
      return { tab: 'jellyfin', ...(await loadJellyfin(ctx.base('jellyfin'))) }
  }
}


/* ── Jellyfin ─────────────────────────────────────────────────────────── */

type JellyfinData = {
  version: string | null
  gap: VersionGap
  serverName: string | null
  /** The server is holding an update it cannot apply without a restart. */
  pendingRestart: boolean
  playing: {
    user: string
    title: string
    sub: string | null
    pct: number | null
    paused: boolean
    device: string | null
    method: string | null
  }[]
  counts: { movies: number | null; series: number | null; episodes: number | null }
  library: { usedBytes: number | null; freeBytes: number | null; growth: number[] }
  /** Everyone with an account, most recently seen first. */
  people: { name: string; lastSeenDays: number | null; lastLoginDays: number | null }[]
}

async function loadJellyfin(base: string): Promise<JellyfinData> {
  const h = { headers: { 'X-Emby-Token': key('JELLYFIN_API_KEY') } }
  const now = Date.now()

  const [info, counts, sessions, users, disk, growth] = await Promise.all([
    getJson<{ Version?: string; ServerName?: string; HasPendingRestart?: boolean }>(
      `${base}/System/Info`,
      h,
    ),
    getJson<{ MovieCount?: number; SeriesCount?: number; EpisodeCount?: number }>(
      `${base}/Items/Counts`,
      h,
    ),
    getJson<
      {
        UserName?: string
        DeviceName?: string
        NowPlayingItem?: { Name?: string; SeriesName?: string; RunTimeTicks?: number }
        PlayState?: { PositionTicks?: number; IsPaused?: boolean; PlayMethod?: string }
      }[]
    >(`${base}/Sessions`, h),
    getJson<{ Name?: string; LastActivityDate?: string; LastLoginDate?: string }[]>(
      `${base}/Users`,
      h,
    ),
    promScalars({
      size: 'node_filesystem_size_bytes{mountpoint="/s2/tv"}',
      avail: 'node_filesystem_avail_bytes{mountpoint="/s2/tv"}',
    }),
    // One point every 12h over a month: the library grows in episode-sized
    // steps, so a finer step is a flat line with noise on it.
    promSeries(
      'node_filesystem_size_bytes{mountpoint="/s2/tv"} - node_filesystem_avail_bytes{mountpoint="/s2/tv"}',
      30 * 24 * 60,
      43200,
    ),
  ])

  const version = info?.Version ?? null

  return {
    version,
    // Two-or-three segments: Jellyfin's stable line is `v10.11.11` but a `.0`
    // release is tagged `v12.0`, and a pattern that only matched three would
    // silently drop the release it is most important to notice.
    gap: await versionGap('jellyfin/jellyfin', version, { tag: /^v?(\d+\.\d+(?:\.\d+)?)$/ }),
    serverName: info?.ServerName ?? null,
    pendingRestart: info?.HasPendingRestart === true,
    // Only sessions actually playing something: every poller that has ever
    // asked Jellyfin a question holds an idle session for a while afterwards,
    // so the raw list reports an audience that is not in the room.
    playing: (sessions ?? [])
      .filter((s) => s.NowPlayingItem !== undefined)
      .map((s) => {
        const item = s.NowPlayingItem
        const runtime = item?.RunTimeTicks ?? 0
        const position = s.PlayState?.PositionTicks ?? 0
        return {
          user: s.UserName ?? 'someone',
          title: item?.SeriesName ?? item?.Name ?? 'something',
          sub: item?.SeriesName === undefined ? null : (item.Name ?? null),
          pct: runtime > 0 ? (position / runtime) * 100 : null,
          paused: s.PlayState?.IsPaused === true,
          device: s.DeviceName ?? null,
          // Transcode vs DirectPlay is the difference between a quiet box and
          // a pegged iGPU, which is why it is on the row rather than in a log.
          method: s.PlayState?.PlayMethod ?? null,
        }
      }),
    counts: {
      movies: counts?.MovieCount ?? null,
      series: counts?.SeriesCount ?? null,
      episodes: counts?.EpisodeCount ?? null,
    },
    library: {
      usedBytes: disk.size !== null && disk.avail !== null ? disk.size - disk.avail : null,
      freeBytes: disk.avail,
      growth,
    },
    // Days rather than timestamps, computed here: this page renders on the
    // server and hydrates in the browser, and a relative time derived from two
    // clocks is a hydration mismatch waiting for midnight.
    people: (users ?? [])
      .map((u) => ({
        name: u.Name ?? '?',
        lastSeenDays: daysSince(u.LastActivityDate, now),
        lastLoginDays: daysSince(u.LastLoginDate, now),
      }))
      .sort((a, b) => (a.lastSeenDays ?? 1e9) - (b.lastSeenDays ?? 1e9)),
  }
}

/* ── Seerr ────────────────────────────────────────────────────────────── */

type SeerrData = {
  version: string | null
  gap: VersionGap
  /** Seerr's own opinion of whether it is behind — a second source, not a repeat. */
  selfBehind: number | null
  counts: {
    total: number | null
    pending: number | null
    approved: number | null
    processing: number | null
    available: number | null
    declined: number | null
  }
  /** Newest first, with the title resolved — see `titleOf`. */
  requests: {
    title: string
    kind: 'movie' | 'tv'
    status: string
    tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted'
    by: string
    ageDays: number | null
  }[]
  /** Who does the asking. */
  people: { name: string; requests: number }[]
}

/**
 * A request's status, as words.
 *
 * Two codes matter to a reader and the rest are bookkeeping: 1 is waiting for
 * somebody to say yes, and 3 was refused. Everything else means the machinery
 * has it, and the interesting distinction there is whether the file has landed
 * — which is the MEDIA's status, not the request's.
 */
const REQUEST_STATE: Record<number, { label: string; tone: SeerrData['requests'][number]['tone'] }> =
  {
    1: { label: 'pending', tone: 'warn' },
    2: { label: 'approved', tone: 'info' },
    3: { label: 'declined', tone: 'bad' },
    4: { label: 'failed', tone: 'bad' },
    5: { label: 'available', tone: 'ok' },
  }

/** How many recent requests get their title looked up. See `titleOf`. */
const REQUESTS_SHOWN = 8

async function loadSeerr(base: string): Promise<SeerrData> {
  const h = { headers: { 'X-Api-Key': key('SEERR_API_KEY') } }
  const now = Date.now()

  const [status, counts, list, users] = await Promise.all([
    getJson<{ version?: string; commitsBehind?: number }>(`${base}/api/v1/status`, h),
    getJson<{
      total?: number
      pending?: number
      approved?: number
      processing?: number
      available?: number
      declined?: number
    }>(`${base}/api/v1/request/count`, h),
    getJson<{
      results?: {
        type?: string
        status?: number
        createdAt?: string
        media?: { tmdbId?: number; status?: number }
        requestedBy?: { displayName?: string; username?: string }
      }[]
    }>(`${base}/api/v1/request?take=${String(REQUESTS_SHOWN)}&sort=added`, h),
    getJson<{ results?: { displayName?: string; username?: string; requestCount?: number }[] }>(
      `${base}/api/v1/user?take=20&sort=requests`,
      h,
    ),
  ])

  const version = status?.version ?? null
  const rows = list?.results ?? []

  // Titles come from a second call each, because a request record carries a
  // tmdbId and nothing else — no title, no year, no poster. Seerr's own UI
  // resolves them the same way and caches the answers, so this is a warm local
  // lookup rather than a TMDB round trip. Capped at what is displayed, and
  // pooled: eight cold lookups in parallel is a burst this box has no reason
  // to send at a service that is answering the page it is on.
  const titles = await pool(
    rows.map((r) => () => titleOf(base, h, r.type === 'tv' ? 'tv' : 'movie', r.media?.tmdbId)),
    4,
  )

  return {
    version,
    gap: await versionGap('seerr-team/seerr', version),
    selfBehind: status?.commitsBehind ?? null,
    counts: {
      total: counts?.total ?? null,
      pending: counts?.pending ?? null,
      approved: counts?.approved ?? null,
      processing: counts?.processing ?? null,
      available: counts?.available ?? null,
      declined: counts?.declined ?? null,
    },
    requests: rows.map((r, i) => {
      const state = REQUEST_STATE[r.status ?? 0] ?? { label: 'unknown', tone: 'muted' as const }
      return {
        title: titles[i] ?? `#${String(r.media?.tmdbId ?? 0)}`,
        kind: r.type === 'tv' ? ('tv' as const) : ('movie' as const),
        // The media's own status wins where it is further along: a request can
        // sit "approved" forever while the file it asked for arrived days ago,
        // and "approved" is then the least true thing on the row.
        ...(r.status === 2 && r.media?.status === 5 ?
          { status: 'available', tone: 'ok' as const }
        : { status: state.label, tone: state.tone }),
        by: r.requestedBy?.displayName ?? r.requestedBy?.username ?? 'someone',
        ageDays: daysSince(r.createdAt, now),
      }
    }),
    people: (users?.results ?? [])
      .map((u) => ({
        name: u.displayName ?? u.username ?? '?',
        requests: u.requestCount ?? 0,
      }))
      .filter((u) => u.requests > 0)
      .sort((a, b) => b.requests - a.requests),
  }
}

async function titleOf(
  base: string,
  h: RequestInit,
  kind: 'movie' | 'tv',
  tmdbId: number | undefined,
): Promise<string | null> {
  if (tmdbId === undefined) return null
  const b = await getJson<{
    title?: string
    name?: string
    releaseDate?: string
    firstAirDate?: string
  }>(`${base}/api/v1/${kind}/${String(tmdbId)}`, h)
  if (b === null) return null
  // A film has `title`, a series has `name` — the only place the two shapes
  // differ that matters here.
  const title = b.title ?? b.name
  if (title === undefined) return null
  const year = (b.releaseDate ?? b.firstAirDate ?? '').slice(0, 4)
  return year === '' ? title : `${title} (${year})`
}

/* ── Sonarr and Radarr ────────────────────────────────────────────────── */

/**
 * One shape for both, because they ARE one program.
 *
 * Sonarr and Radarr are the same codebase pointed at different content: the
 * same v3 API, the same queue, the same health checks, the same history events.
 * Writing them as two loaders and two views would be two copies of one thing
 * that then drift, and the places where they genuinely differ — episodes have
 * an air date, movies have three release dates — are a field, not a file.
 */
type ArrData = {
  app: 'sonarr' | 'radarr'
  version: string | null
  gap: VersionGap
  /** The service's OWN health checks. Nothing else on this box reports these. */
  health: { level: 'warn' | 'bad'; source: string; message: string; url: string | null }[]
  counts: {
    /** Series, or movies. */
    library: number | null
    monitored: number | null
    /** Missing and monitored — what it is still looking for. */
    wanted: number | null
    queued: number | null
    /** What the library occupies, as the *arr itself measures it. */
    sizeBytes: number | null
  }
  queue: {
    title: string
    status: string
    pct: number
    sizeBytes: number
    /** Set when the *arr flagged the item — a manual import, a failed unpack. */
    issue: string | null
  }[]
  /** Airing or releasing in the next fortnight, soonest first. */
  upcoming: { title: string; sub: string | null; date: string; inDays: number; have: boolean }[]
  /** What it has been doing, newest first. */
  history: { title: string; event: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; ageDays: number | null }[]
  /** Where the library lives, as the container sees it. */
  disk: { path: string; freeBytes: number; totalBytes: number }[]
}

const ARRS = {
  sonarr: {
    port: 8989,
    keyName: 'SONARR_API_KEY',
    repo: 'Sonarr/Sonarr',
    /** The collection endpoint, which is also what "library" counts. */
    items: 'series',
  },
  radarr: {
    port: 7878,
    keyName: 'RADARR_API_KEY',
    repo: 'Radarr/Radarr',
    items: 'movie',
  },
} as const

/** Four-segment tags: the *arrs number their builds — see `cmp` in github.ts. */
const ARR_TAG = /^v?(\d+\.\d+\.\d+\.\d+)$/

/** How far ahead the calendar looks. Two weeks is a fortnight of evenings. */
const CALENDAR_DAYS = 14

async function loadArr(app: 'sonarr' | 'radarr', ctx: Ctx): Promise<ArrData> {
  const cfg = ARRS[app]
  // gluetun owns the netns, so only gluetun publishes ports — the *arrs are
  // reachable at the host port and nowhere else.
  const base = `${ctx.hc}:${String(cfg.port)}/api/v3`
  const k = `apikey=${key(cfg.keyName)}`
  const now = Date.now()
  const day = 86_400_000

  const [status, health, items, wanted, queue, calendar, history, disk] = await Promise.all([
    getJson<{ version?: string }>(`${base}/system/status?${k}`),
    getJson<{ type?: string; source?: string; message?: string; wikiUrl?: string }[]>(
      `${base}/health?${k}`,
    ),
    getJson<{ monitored?: boolean; statistics?: { sizeOnDisk?: number } }[]>(
      `${base}/${cfg.items}?${k}`,
    ),
    getJson<{ totalRecords?: number }>(`${base}/wanted/missing?pageSize=1&${k}`),
    getJson<{
      totalRecords?: number
      records?: {
        title?: string
        status?: string
        size?: number
        sizeleft?: number
        trackedDownloadStatus?: string
        statusMessages?: { title?: string }[]
        errorMessage?: string
      }[]
    }>(`${base}/queue?pageSize=20&includeEpisode=true&includeSeries=true&includeMovie=true&${k}`),
    getJson<
      {
        title?: string
        seriesTitle?: string
        series?: { title?: string }
        seasonNumber?: number
        episodeNumber?: number
        airDateUtc?: string
        inCinemas?: string
        digitalRelease?: string
        physicalRelease?: string
        hasFile?: boolean
        episodeFileId?: number
      }[]
    >(
      `${base}/calendar?start=${iso(now)}&end=${iso(now + CALENDAR_DAYS * day)}&includeSeries=true&${k}`,
    ),
    getJson<{
      records?: {
        eventType?: string
        date?: string
        sourceTitle?: string
        episode?: { title?: string }
        movie?: { title?: string }
        series?: { title?: string }
      }[]
    }>(`${base}/history?pageSize=12&sortKey=date&sortDirection=descending&${k}`),
    getJson<{ path?: string; freeSpace?: number; totalSpace?: number }[]>(`${base}/diskspace?${k}`),
  ])

  const version = status?.version ?? null
  const library = items ?? null

  return {
    app,
    version,
    gap: await versionGap(cfg.repo, version, { tag: ARR_TAG }),
    health: (health ?? [])
      // `notice` is the level the *arrs use for "this is how it is configured",
      // which is not a fault and would sit permanently on the panel.
      .filter((h) => h.type === 'warning' || h.type === 'error')
      .map((h) => ({
        level: h.type === 'error' ? ('bad' as const) : ('warn' as const),
        source: (h.source ?? '').replace(/Check$/, ''),
        message: h.message ?? '',
        url: h.wikiUrl ?? null,
      })),
    counts: {
      library: library?.length ?? null,
      monitored: library === null ? null : library.filter((i) => i.monitored === true).length,
      wanted: wanted?.totalRecords ?? null,
      queued: queue?.totalRecords ?? null,
      sizeBytes:
        library === null ?
          null
        : library.reduce((n, i) => n + (i.statistics?.sizeOnDisk ?? 0), 0),
    },
    queue: (queue?.records ?? []).map((r) => {
      const size = r.size ?? 0
      const left = r.sizeleft ?? 0
      return {
        title: r.title ?? '?',
        status: r.status ?? 'unknown',
        pct: size > 0 ? ((size - left) / size) * 100 : 0,
        sizeBytes: size,
        // The one field on this endpoint nothing else reports: an item sitting
        // at 100% that will never import, because it needs a hand.
        issue:
          r.errorMessage ??
          r.statusMessages?.[0]?.title ??
          (r.trackedDownloadStatus === 'warning' || r.trackedDownloadStatus === 'error' ?
            r.trackedDownloadStatus
          : null),
      }
    }),
    upcoming: (calendar ?? [])
      .map((c) => {
        // Sonarr answers with an air date; Radarr with up to three release
        // dates, of which the earliest that exists is the one worth showing —
        // a cinema date is when it becomes findable at all.
        const when =
          c.airDateUtc ??
          [c.digitalRelease, c.physicalRelease, c.inCinemas]
            .filter((d): d is string => d !== undefined)
            .sort()[0] ??
          null
        if (when === null) return null
        const stamp = Date.parse(when)
        const episode =
          c.seasonNumber === undefined || c.episodeNumber === undefined ?
            null
          : `S${String(c.seasonNumber).padStart(2, '0')}E${String(c.episodeNumber).padStart(2, '0')}`
        return {
          title: c.series?.title ?? c.seriesTitle ?? c.title ?? '?',
          sub: episode === null ? null : `${episode} · ${c.title ?? ''}`.trim(),
          date: when.slice(0, 10),
          inDays: Math.round((stamp - now) / day),
          have: c.hasFile === true || (c.episodeFileId ?? 0) > 0,
        }
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .sort((a, b) => a.inDays - b.inDays)
      .slice(0, 12),
    history: (history?.records ?? []).map((r) => {
      const kind = r.eventType ?? ''
      return {
        title: r.series?.title ?? r.movie?.title ?? r.episode?.title ?? r.sourceTitle ?? '?',
        // An unmapped event type is shown as itself rather than as "unknown":
        // the *arrs add new ones, and the raw name is always more informative
        // than a placeholder that hides which one it was.
        ...(EVENTS[kind] ?? { event: kind === '' ? 'unknown' : kind, tone: 'muted' as const }),
        ageDays: daysSince(r.date, now),
      }
    }),
    disk: (disk ?? [])
      // `/config` and `/` are the container's own filesystem, which is the box's
      // root disk under a different name — the library is the only one that
      // says anything here.
      .filter((d) => d.path === '/data' || d.path === '/s2/tv')
      .map((d) => ({
        path: d.path ?? '?',
        freeBytes: d.freeSpace ?? 0,
        totalBytes: d.totalSpace ?? 0,
      })),
  }
}

/**
 * History event types, as words and a tone.
 *
 * Only `downloadFailed` and `importFailed` are coloured. A grab and an import
 * are the machine working, and colouring them makes the two events that mean
 * somebody has to look invisible in a wall of green.
 */
const EVENTS: Record<string, { event: string; tone: 'ok' | 'warn' | 'bad' | 'muted' }> = {
  grabbed: { event: 'grabbed', tone: 'muted' },
  downloadFolderImported: { event: 'imported', tone: 'muted' },
  downloadFailed: { event: 'download failed', tone: 'bad' },
  importFailed: { event: 'import failed', tone: 'bad' },
  episodeFileDeleted: { event: 'file deleted', tone: 'warn' },
  movieFileDeleted: { event: 'file deleted', tone: 'warn' },
  episodeFileRenamed: { event: 'renamed', tone: 'muted' },
  movieFileRenamed: { event: 'renamed', tone: 'muted' },
  movieFolderImported: { event: 'imported', tone: 'muted' },
}

/* ── Prowlarr ─────────────────────────────────────────────────────────── */

type ProwlarrData = {
  version: string | null
  gap: VersionGap
  health: ArrData['health']
  counts: { enabled: number | null; disabled: number | null }
  /** Busiest first. */
  indexers: {
    name: string
    enabled: boolean
    protocol: string
    queries: number
    grabs: number
    failedQueries: number
    failedGrabs: number
    /** Milliseconds. Null when it has never been asked. */
    responseMs: number | null
  }[]
}

async function loadProwlarr(ctx: Ctx): Promise<ProwlarrData> {
  const base = `${ctx.hc}:9696/api/v1`
  const k = `apikey=${key('PROWLARR_API_KEY')}`

  const [status, health, stats, indexers] = await Promise.all([
    getJson<{ version?: string }>(`${base}/system/status?${k}`),
    getJson<{ type?: string; source?: string; message?: string; wikiUrl?: string }[]>(
      `${base}/health?${k}`,
    ),
    getJson<{
      indexers?: {
        indexerName?: string
        numberOfQueries?: number
        numberOfGrabs?: number
        numberOfFailedQueries?: number
        numberOfFailedGrabs?: number
        averageResponseTime?: number
      }[]
    }>(`${base}/indexerstats?${k}`),
    getJson<{ name?: string; enable?: boolean; protocol?: string }[]>(`${base}/indexer?${k}`),
  ])

  const version = status?.version ?? null
  const byName = new Map((indexers ?? []).map((i) => [i.name ?? '', i]))

  return {
    version,
    gap: await versionGap('Prowlarr/Prowlarr', version, { tag: ARR_TAG }),
    health: (health ?? [])
      .filter((h) => h.type === 'warning' || h.type === 'error')
      .map((h) => ({
        level: h.type === 'error' ? ('bad' as const) : ('warn' as const),
        source: (h.source ?? '').replace(/Check$/, ''),
        message: h.message ?? '',
        url: h.wikiUrl ?? null,
      })),
    counts: {
      enabled: indexers === null ? null : indexers.filter((i) => i.enable === true).length,
      disabled: indexers === null ? null : indexers.filter((i) => i.enable !== true).length,
    },
    indexers: (stats?.indexers ?? [])
      .map((s) => {
        const name = s.indexerName ?? '?'
        const meta = byName.get(name)
        return {
          name,
          // An indexer with stats and no entry in the list has been deleted
          // since those queries were counted; it is not enabled.
          enabled: meta?.enable === true,
          protocol: meta?.protocol ?? 'unknown',
          queries: s.numberOfQueries ?? 0,
          grabs: s.numberOfGrabs ?? 0,
          failedQueries: s.numberOfFailedQueries ?? 0,
          failedGrabs: s.numberOfFailedGrabs ?? 0,
          responseMs: s.averageResponseTime ?? null,
        }
      })
      .sort((a, b) => b.queries - a.queries),
  }
}

/* ── Bazarr ───────────────────────────────────────────────────────────── */

type BazarrData = {
  version: string | null
  gap: VersionGap
  wanted: { episodes: number | null; movies: number | null }
  /** What Bazarr thinks the *arrs are running — a cross-check, cheaply. */
  linked: { sonarr: string | null; radarr: string | null }
  /**
   * Subtitle providers and their state.
   *
   * The one thing on this page that explains a subtitle that never arrives:
   * a provider Bazarr has throttled answers nothing and reports no error, and
   * "Good" here is the difference between "no subtitles exist" and "we are not
   * currently allowed to ask".
   */
  providers: { name: string; status: string; retry: string; ok: boolean }[]
  /** Whisper transcription, which runs beside Bazarr in gluetun's netns. */
  subgen: string | null
}

async function loadBazarr(ctx: Ctx): Promise<BazarrData> {
  const h = { headers: { 'X-API-KEY': key('BAZARR_API_KEY') } }
  const base = `${ctx.hc}:6767/api`

  const [status, eps, movies, providers, subgen] = await Promise.all([
    getJson<{ data?: { bazarr_version?: string; sonarr_version?: string; radarr_version?: string } }>(
      `${base}/system/status`,
      h,
    ),
    getJson<{ total?: number }>(`${base}/episodes/wanted`, h),
    getJson<{ total?: number }>(`${base}/movies/wanted`, h),
    getJson<{ data?: { name?: string; status?: string; retry?: string }[] }>(
      `${base}/providers`,
      h,
    ),
    getJson<{ version?: string }>(`${ctx.hc}:9000/status`),
  ])

  const version = status?.data?.bazarr_version ?? null

  return {
    version,
    gap: await versionGap('morpheus65535/bazarr', version),
    wanted: { episodes: eps?.total ?? null, movies: movies?.total ?? null },
    linked: {
      sonarr: status?.data?.sonarr_version ?? null,
      radarr: status?.data?.radarr_version ?? null,
    },
    providers: (providers?.data ?? []).map((p) => ({
      name: p.name ?? '?',
      status: p.status ?? 'unknown',
      retry: p.retry ?? '-',
      ok: p.status === 'Good',
    })),
    // `Subgen 2026.07.3, stable-ts 2.19.1, faster-whisper 1.2.1 (Standalone)` —
    // three versions in one string, and the first is the only one that names
    // the container.
    subgen: /^Subgen\s+(\S+?),/.exec(subgen?.version ?? '')?.[1] ?? null,
  }
}

/* ── Downloads ────────────────────────────────────────────────────────── */

/**
 * Three downloaders on one tab, and it is one tab because they are one job.
 *
 * qBittorrent and NZBGet are fed by the same *arrs and land in the same folder;
 * MeTube is the manual case, the thing you point at a URL yourself. Each has
 * its own version and its own log, which is why they get sections rather than a
 * merged list — but "what is downloading right now" has one answer and it
 * should be in one place.
 */
type DownloadsData = {
  qbt: {
    version: string | null
    gap: VersionGap
    /** Null when the login failed — everything below it is then empty. */
    reachable: boolean
    down: number | null
    up: number | null
    sessionDown: number | null
    sessionUp: number | null
    connection: string | null
    freeBytes: number | null
    transfers: {
      name: string
      pct: number
      state: string
      down: number
      up: number
      etaSeconds: number | null
      size: number
      active: boolean
      ratio: number
    }[]
    counts: { leeching: number; seeding: number; stalled: number; errored: number }
  }
  nzb: {
    version: string | null
    gap: VersionGap
    rate: number | null
    remainingBytes: number | null
    downloadedBytes: number | null
    /** This calendar month and today, as NZBGet counts them. */
    monthBytes: number | null
    dayBytes: number | null
    paused: boolean
    standby: boolean
    /** Seconds since the container started, by NZBGet's own clock. */
    uptimeSeconds: number | null
    /** Of that uptime, how much was spent actually downloading. */
    downloadSeconds: number | null
    freeBytes: number | null
    /**
     * The upstream usenet providers and whether NZBGet is using them.
     *
     * The failure this surfaces: a provider whose subscription lapsed goes
     * inactive and everything simply stops being found, which looks exactly
     * like "the release is not on usenet".
     */
    servers: { id: number; active: boolean }[]
    groups: { name: string; pct: number; remainingBytes: number }[]
  }
  metube: {
    version: string | null
    gap: VersionGap
    queued: number | null
    pending: number | null
    done: number | null
    /** The most recent finished items, newest last as MeTube stores them. */
    recent: { title: string; status: string }[]
  }
  /**
   * The fourth downloader, and the reason it is here rather than beside the
   * shelf it fills: it is a downloader. Pairing it with Calibre-Web put one
   * downloader on the far side of the tab row's rule from the other three,
   * which made "where do I look when something is not arriving" depend on
   * whether the thing was a book.
   */
  shelfmark: {
    /**
     * From the image's own OCI label, because the pin cannot say.
     *
     * Shelfmark is pinned by digest to a moving `:latest`, so the tag names a
     * channel. The image itself carries `org.opencontainers.image.version`,
     * which is a fact about the artefact on disk — see lib/dashboard/images.ts.
     */
    running: RunningVersion
    gap: VersionGap
    jobs: { title: string; state: string; pct: number | null }[]
    counts: { downloading: number; queued: number; done: number; errors: number } | null
  }
  /**
   * The tunnel every torrent and article goes through.
   *
   * Three facts, not a panel: the tunnel has a page of its own on Network ›
   * Going out, and the only part of it that belongs HERE is the part that
   * silently changes what this tab is reporting. A tunnel that is up but has
   * lost its forwarded port looks perfectly healthy and cannot seed.
   */
  vpn: { up: boolean | null; country: string | null; port: number | null }
}

async function loadDownloads(ctx: Ctx): Promise<DownloadsData> {
  const qbtBase = `${ctx.hc}:8090`
  const nzbBase = `${ctx.hc}:6789`

  const [
    qbt,
    nzbVersion,
    nzbStatus,
    nzbGroups,
    metubeHistory,
    vpnIp,
    vpnPort,
    vpnUp,
    shelfmarkStatus,
    shelfmark,
  ] = await Promise.all([
      loadQbt(qbtBase),
      getJson<{ result?: string }>(`${nzbBase}/jsonrpc/version`),
      getJson<{
        result?: {
          DownloadRate?: number
          RemainingSizeMB?: number
          DownloadedSizeMB?: number
          MonthSizeMB?: number
          DaySizeMB?: number
          DownloadPaused?: boolean
          ServerStandBy?: boolean
          UpTimeSec?: number
          DownloadTimeSec?: number
          FreeDiskSpaceMB?: number
          NewsServers?: { ID?: number; Active?: boolean }[]
        }
      }>(`${nzbBase}/jsonrpc/status`),
      getJson<{ result?: { NZBName?: string; FileSizeMB?: number; RemainingSizeMB?: number }[] }>(
        `${nzbBase}/jsonrpc/listgroups`,
      ),
      // Through traefik on a scoped bypass (`GET /history`, stacks/metube):
      // metube is on traefik-net only, and daedalus is deliberately not.
      getJson<{
        queue?: { title?: string; status?: string }[]
        pending?: { title?: string }[]
        done?: { title?: string; status?: string }[]
      }>(`${ctx.base('metube')}/history`),
      getJson<{ country?: string }>(`${ctx.hc}:8000/v1/publicip/ip`),
      getJson<{ port?: number }>(`${ctx.hc}:8000/v1/portforward`),
      promScalars({ up: 'gluetun_vpn_status' }),
      // Keyed by state, then by job id — see stacks/shelfmark. The inner
      // records are loosely typed on purpose: the fields vary by state and
      // only the title and progress are ever present.
      getJson<Record<string, Record<string, { title?: string; progress?: number }>>>(
        `${ctx.hc}:8084/api/status`,
      ),
      // Pinned by digest to a moving `:latest`, so only the image knows.
      imageVersion('shelfmark'),
    ])

  const nzbVer = nzbVersion?.result ?? null
  const metubeVer = imageTag('metube')
  const r = nzbStatus?.result

  const [qbtGap, nzbGap, metubeGap, shelfmarkGap] = await Promise.all([
    versionGap('qbittorrent/qBittorrent', qbt.version, { tag: /^release-(\d+\.\d+\.\d+)$/ }),
    versionGap('nzbgetcom/nzbget', nzbVer, { tag: /^v?(\d+\.\d+(?:\.\d+)?)$/ }),
    versionGap('alexta69/metube', metubeVer, { tag: /^(\d{4}\.\d{2}\.\d{2})$/ }),
    // A real gap now that the label supplies a version. `notesWhenUnknown`
    // stays as the fallback for the day a publisher stops setting the label:
    // the panel then shows what has shipped rather than going blank.
    versionGap('calibrain/shelfmark', shelfmark.version, { notesWhenUnknown: true }),
  ])

  const done = metubeHistory?.done ?? []
  const bucket = (state: string) => Object.values(shelfmarkStatus?.[state] ?? {})

  return {
    qbt: { ...qbt, gap: qbtGap },
    nzb: {
      version: nzbVer,
      gap: nzbGap,
      rate: r?.DownloadRate ?? null,
      remainingBytes: mb(r?.RemainingSizeMB),
      downloadedBytes: mb(r?.DownloadedSizeMB),
      monthBytes: mb(r?.MonthSizeMB),
      dayBytes: mb(r?.DaySizeMB),
      paused: r?.DownloadPaused === true,
      standby: r?.ServerStandBy === true,
      uptimeSeconds: r?.UpTimeSec ?? null,
      downloadSeconds: r?.DownloadTimeSec ?? null,
      freeBytes: mb(r?.FreeDiskSpaceMB),
      servers: (r?.NewsServers ?? []).map((s) => ({
        id: s.ID ?? 0,
        active: s.Active === true,
      })),
      groups: (nzbGroups?.result ?? []).map((g) => {
        const total = g.FileSizeMB ?? 0
        const left = g.RemainingSizeMB ?? 0
        return {
          name: g.NZBName ?? '?',
          pct: total > 0 ? ((total - left) / total) * 100 : 0,
          remainingBytes: left * 1024 * 1024,
        }
      }),
    },
    metube: {
      version: metubeVer,
      gap: metubeGap,
      queued: metubeHistory?.queue?.length ?? null,
      pending: metubeHistory?.pending?.length ?? null,
      done: done.length,
      recent: done
        .slice(-6)
        .reverse()
        .map((d) => ({ title: d.title ?? '?', status: d.status ?? 'finished' })),
    },
    shelfmark: {
      running: shelfmark,
      gap: shelfmarkGap,
      jobs: ['downloading', 'resolving', 'locating', 'queued', 'error']
        .flatMap((state) =>
          bucket(state).map((j) => ({
            title: j.title ?? 'untitled',
            state,
            pct: typeof j.progress === 'number' ? j.progress : null,
          })),
        )
        .slice(0, 12),
      counts:
        shelfmarkStatus === null ? null : (
          {
            downloading: bucket('downloading').length,
            queued: bucket('queued').length + bucket('resolving').length + bucket('locating').length,
            done: bucket('complete').length,
            errors: bucket('error').length,
          }
        ),
    },
    vpn: {
      up: vpnUp.up === null ? null : vpnUp.up === 1,
      country: vpnIp?.country ?? null,
      port: vpnPort?.port ?? null,
    },
  }
}

/**
 * qBittorrent behind ONE login.
 *
 * The auth is a cookie handed out by a POST, and that POST is the most
 * expensive call on this page — a password check against a service inside
 * gluetun's netns. Four readings want it; they get one session between them.
 */
async function loadQbt(base: string): Promise<Omit<DownloadsData['qbt'], 'gap'>> {
  const empty = {
    version: null,
    reachable: false,
    down: null,
    up: null,
    sessionDown: null,
    sessionUp: null,
    connection: null,
    freeBytes: null,
    transfers: [],
    counts: { leeching: 0, seeding: 0, stalled: 0, errored: 0 },
  }

  const cookie = await qbtCookie(base)
  if (cookie === null) return empty
  const h = { headers: { Cookie: cookie } }

  const [version, list, transfer, sync] = await Promise.all([
    getText(`${base}/api/v2/app/version`),
    getJson<
      {
        name: string
        progress: number
        state: string
        dlspeed: number
        upspeed: number
        eta: number
        size: number
        ratio: number
      }[]
    >(`${base}/api/v2/torrents/info`, h),
    getJson<{
      dl_info_speed?: number
      up_info_speed?: number
      dl_info_data?: number
      up_info_data?: number
      connection_status?: string
    }>(`${base}/api/v2/transfer/info`, h),
    // Free space is on the sync snapshot rather than anywhere obvious: it is
    // what qBittorrent itself reports for the download path, which is the
    // number that decides whether the next grab fits.
    getJson<{ server_state?: { free_space_on_disk?: number } }>(`${base}/api/v2/sync/maindata`, h),
  ])

  const torrents = list ?? []
  const inState = (re: RegExp) => torrents.filter((t) => re.test(t.state)).length

  return {
    // `v5.2.3` — the leading v is the API's, not the version's.
    version: version === null ? null : version.trim().replace(/^v/, ''),
    reachable: true,
    down: transfer?.dl_info_speed ?? null,
    up: transfer?.up_info_speed ?? null,
    sessionDown: transfer?.dl_info_data ?? null,
    sessionUp: transfer?.up_info_data ?? null,
    connection: transfer?.connection_status ?? null,
    freeBytes: sync?.server_state?.free_space_on_disk ?? null,
    transfers: torrents
      .map((t) => ({
        name: t.name,
        pct: t.progress * 100,
        state: t.state,
        down: t.dlspeed,
        up: t.upspeed,
        // qBittorrent encodes "no estimate" as 8640000 (100 days) rather than
        // null, and rendering that literally would put "100d" next to a torrent
        // that is simply idle.
        etaSeconds: t.eta >= 8640000 ? null : t.eta,
        size: t.size,
        active: t.dlspeed > 0 || t.upspeed > 0,
        ratio: t.ratio,
      }))
      // Moving first, then closest to done. A downloader panel is read top-down
      // and the top should be the thing that will change while you look at it.
      .sort((a, b) => Number(b.active) - Number(a.active) || b.pct - a.pct)
      .slice(0, 12),
    counts: {
      leeching: inState(/^(downloading|metaDL|forcedDL)$/i),
      seeding: inState(/^(uploading|forcedUP)$/i),
      stalled: inState(/^stalled/i),
      errored: inState(/^(error|missingFiles)$/i),
    },
  }
}

/* ── Calibre ──────────────────────────────────────────────────────────── */

/**
 * The book shelf, beside Jellyfin rather than in a "Books" section.
 *
 * Both are the END of a pipeline — the thing a person actually opens — and
 * everything after the rule on the tab row is machinery that fills them. Books
 * used to be its own tab pairing the shelf with its downloader, which put a
 * downloader on the far side of that line from every other downloader.
 */
type CalibreData = {
  version: string | null
  gap: VersionGap
  books: number | null
  authors: number | null
  series: number | null
  categories: number | null
  disk: { usedBytes: number | null; freeBytes: number | null }
}

async function loadCalibre(ctx: Ctx): Promise<CalibreData> {
  const version = imageTag('calibre-web')

  const [stats, disk, gap] = await Promise.all([
    // /opds is on calibre-web's forward-auth bypass and takes its own basic
    // auth (stacks/calibre-web), so this reads it with those credentials.
    getJson<{ books?: number; authors?: number; categories?: number; series?: number }>(
      `${ctx.base('calibre-web')}/opds/stats`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${key('CALIBREWEB_USER')}:${key('CALIBREWEB_PASS')}`,
          ).toString('base64')}`,
        },
      },
    ),
    promScalars({
      size: 'node_filesystem_size_bytes{mountpoint="/s2/books"}',
      avail: 'node_filesystem_avail_bytes{mountpoint="/s2/books"}',
    }),
    versionGap('crocodilestick/Calibre-Web-Automated', imageTag('calibre-web'), {
      tag: /^[Vv]?(\d+\.\d+\.\d+)$/,
    }),
  ])

  return {
    version,
    gap,
    books: stats?.books ?? null,
    authors: stats?.authors ?? null,
    series: stats?.series ?? null,
    categories: stats?.categories ?? null,
    disk: {
      usedBytes: disk.size !== null && disk.avail !== null ? disk.size - disk.avail : null,
      freeBytes: disk.avail,
    },
  }
}

/* ── Cleanup ──────────────────────────────────────────────────────────── */

/**
 * The three services that act ON the library rather than filling it.
 *
 * They share a tab because they share a failure mode: all three do their work
 * on a timer, none of them has a UI you would open unprompted, and the only
 * evidence any of them is alive is a log line. Two publish no numbers at all,
 * so the counts here are counted out of Loki — which is why the panel says so.
 */
/**
 * Recyclarr, which lives with Sonarr and Radarr rather than with the cleaners.
 *
 * It was grouped with Cleanuparr and Janitorr on the grounds that all three are
 * timers nobody watches — true, and the wrong axis. What Recyclarr actually
 * DOES is write custom formats and scoring into the two *arrs, so its output
 * is their configuration and the page you want it next to is theirs. The
 * cleaners act on the download queue and the library instead.
 */
type RecyclarrData = {
  /**
   * From the image label, and it took a snapshot to get there.
   *
   * Recyclarr is pinned to a bare major (`:8`) — a channel — prints no banner,
   * exposes no API and logs no version, so this was reported as genuinely
   * unknowable. That was wrong: the image says 8.7.0 in
   * `org.opencontainers.image.version`, which is a fact about the artefact on
   * disk and needed nothing but somewhere to read it from.
   */
  running: RunningVersion
  gap: VersionGap
  /** How its last scheduled run ended, and when. */
  lastRun: { ok: boolean; day: string } | null
  errors: number | null
  /**
   * What the last sync actually changed, per *arr instance.
   *
   * The number that makes this service legible: "updated 2, skipped 59" is the
   * difference between a job that ran and a job that did something — including
   * the something that silently reverted a profile somebody edited by hand.
   */
  synced: { instance: string; updated: number; skipped: number }[]
  /** The window `errors` is counted over. */
  days: number
}

type CleanupData = {
  cleanuparr: {
    version: string | null
    gap: VersionGap
    removed: number | null
    blocked: number | null
    searches: number | null
  }
  janitorr: {
    /** From the image label — its pin is the channel `jvm-stable`. */
    running: RunningVersion
    gap: VersionGap
    /** Dry-run: what it WOULD have deleted in the window. */
    wouldDelete: number | null
    /**
     * The cleanups that report their own state, and whether each is armed.
     *
     * Not every cleanup Janitorr has — see `janitorrSchedules` — because only
     * some of them say so, and a list presented as complete would be a claim
     * this box cannot support.
     */
    schedules: { name: string; enabled: boolean }[]
  }
  /** The window both counts are over. */
  days: number
}

const CLEANUP_DAYS = 7

async function loadCleanup(): Promise<CleanupData> {
  const window = `${String(CLEANUP_DAYS)}d`
  const over = (container: string, needle: string) =>
    lokiScalar(
      `sum(count_over_time({container="${container}"} |= \`${needle}\` [${window}])) or vector(0)`,
    )

  // Cleanuparr's tag carries a real version and wins. Its image LABEL says
  // `24.04`, inherited from the Ubuntu base — the exact case that makes the
  // label a fallback rather than the primary. See lib/dashboard/images.ts.
  const cleanuparrVersion = imageTag('cleanuparr')

  const [removed, blocked, searches, wouldDelete, janitorr] = await Promise.all([
    over('cleanuparr', 'Removing item with max strikes'),
    over('cleanuparr', 'blocked item keeps coming back'),
    over('cleanuparr', 'Replacement search triggered'),
    over('janitorr', 'Deleting'),
    // Pinned to the channel `jvm-stable`, so the version comes off the image's
    // own OCI label. It used to be scraped out of Janitorr's startup banner in
    // Loki, which worked only while the container had restarted inside the
    // retention window; past 30 days Loki refuses the range outright and the
    // version silently became "unknown". The label has no such expiry.
    imageVersion('janitorr'),
  ])

  const schedules = await janitorrSchedules()

  const [cleanuparrGap, janitorrGap] = await Promise.all([
    versionGap('Cleanuparr/Cleanuparr', cleanuparrVersion),
    versionGap('Schaka/janitorr', janitorr.version),
  ])

  return {
    cleanuparr: { version: cleanuparrVersion, gap: cleanuparrGap, removed, blocked, searches },
    janitorr: { running: janitorr, gap: janitorrGap, wouldDelete, schedules },
    days: CLEANUP_DAYS,
  }
}

/* ── Recyclarr ────────────────────────────────────────────────────────── */

async function loadRecyclarr(): Promise<RecyclarrData> {
  const window = `${String(CLEANUP_DAYS)}d`

  const [lastRunLine, errors, running, synced] = await Promise.all([
    // How the last scheduled sync ended. Recyclarr has no API, no metrics and
    // no UI, and "did it run, did it succeed" is the only question anybody has
    // about a nightly job.
    lokiLatest('{container="recyclarr"} |~ `msg="job (succeeded|failed)"`'),
    lokiScalar(
      `sum(count_over_time({container="recyclarr"} |~ \`\\[ERR\\]|job failed\` [${window}])) or vector(0)`,
    ),
    // Pinned to a bare major, which is a channel — the image label is the only
    // thing that knows the version.
    imageVersion('recyclarr'),
    recyclarrSynced(CLEANUP_DAYS),
  ])

  const runStamp = /time="([^"T]+)/.exec(lastRunLine ?? '')?.[1] ?? null

  return {
    running,
    gap: await versionGap('recyclarr/recyclarr', running.version, { notesWhenUnknown: true }),
    lastRun:
      runStamp === null ? null : (
        { ok: (lastRunLine ?? '').includes('job succeeded'), day: runStamp }
      ),
    errors,
    synced,
    days: CLEANUP_DAYS,
  }
}

/**
 * The Janitorr cleanups that ANNOUNCE themselves, and whether each is armed.
 *
 * Read from the log because there is nowhere else: Janitorr exposes no API and
 * its configuration lives in a file inside the container. Two of its schedules
 * state their own status every hour when they fire, which a one-day window
 * catches many times over.
 *
 * Deliberately not a claim about every cleanup Janitorr has. Its media-based
 * schedule says nothing at all on this box — enabled or not — so a list
 * presented as complete would report "everything is off" while that one was
 * quietly deleting. The `wouldDelete` count beside this is what covers that
 * case: it counts decisions, whichever schedule reached them.
 */
async function janitorrSchedules(): Promise<CleanupData['janitorr']['schedules']> {
  const kinds = [
    { name: 'Tag', match: 'Tag based cleanup' },
    { name: 'Episode', match: 'Episode based cleanup' },
  ]
  const seen = await Promise.all(
    kinds.map(async (k) => {
      const line = await lokiLatest(`{container="janitorr"} |= \`${k.match}\``, 24 * 60)
      // Absent from the log is not "enabled" — it is "we have not seen it say
      // either", which lands as disabled=false only if a line exists.
      return line === null ? null : { name: k.name, enabled: !line.includes('disabled') }
    }),
  )
  return seen.filter((s): s is NonNullable<typeof s> => s !== null)
}

/** `radarr-main: Updated 2 Existing Custom Formats` and its Skipped sibling. */
async function recyclarrSynced(days: number): Promise<RecyclarrData['synced']> {
  const entries = await lokiEntries(
    `{container="recyclarr"} |~ \`(Updated|Skipped) [0-9]+ .*Custom Formats\``,
    days * 24 * 60,
    200,
  )

  // Newest first, and the FIRST value per instance-and-verb wins: these are the
  // last run's numbers, not a sum over the window. A nightly job that changed
  // two formats every night for a week did not change fourteen.
  const byInstance = new Map<string, { updated: number | null; skipped: number | null }>()
  for (const { line } of entries) {
    const m = /(\S+?): (Updated|Skipped) (\d+)/.exec(line)
    if (m === null) continue
    const [, instance, verb, count] = m
    if (instance === undefined || verb === undefined || count === undefined) continue
    const row = byInstance.get(instance) ?? { updated: null, skipped: null }
    if (verb === 'Updated') row.updated ??= Number(count)
    else row.skipped ??= Number(count)
    byInstance.set(instance, row)
  }

  return [...byInstance].map(([instance, n]) => ({
    instance,
    updated: n.updated ?? 0,
    skipped: n.skipped ?? 0,
  }))
}

/* ── shared ───────────────────────────────────────────────────────────── */

/**
 * Whole days between a timestamp and now.
 *
 * Computed on the server for every page here, deliberately: these components
 * stream and then hydrate, and a relative time derived from the browser's clock
 * renders differently from the one the server sent whenever the two straddle a
 * day boundary. React reports that as a hydration mismatch.
 */
function daysSince(stamp: string | undefined, now: number): number | null {
  if (stamp === undefined || stamp === '') return null
  const t = Date.parse(stamp)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now - t) / 86_400_000))
}

/** `2026-08-06` — what the *arrs' calendar endpoint wants. */
function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** NZBGet reports every size in whole megabytes. */
function mb(v: number | undefined): number | null {
  return v === undefined ? null : v * 1024 * 1024
}

export type {
  ArrData,
  BazarrData,
  CalibreData,
  CleanupData,
  DownloadsData,
  JellyfinData,
  ProwlarrData,
  RecyclarrData,
  SeerrData,
}
