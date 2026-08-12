import { getJson, pool } from '../../../http'
import { key } from '../../../keys'
import { lokiEntries, lokiLatest, lokiScalar } from '../../../loki'
import { type VersionGap, versionGap } from '../../github'
import { imageVersion, type RunningVersion } from '../../images'
import { ARR_TAG, CLEANUP_DAYS, type Ctx, daysSince } from './shared'

/* ── Seerr ────────────────────────────────────────────────────────────── */

export type SeerrData = {
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
const REQUEST_STATE: Record<
  number,
  { label: string; tone: SeerrData['requests'][number]['tone'] }
> = {
  1: { label: 'pending', tone: 'warn' },
  2: { label: 'approved', tone: 'info' },
  3: { label: 'declined', tone: 'bad' },
  4: { label: 'failed', tone: 'bad' },
  5: { label: 'available', tone: 'ok' },
}

/** How many recent requests get their title looked up. See `titleOf`. */
const REQUESTS_SHOWN = 8

export async function loadSeerr(base: string): Promise<SeerrData> {
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
        ...(r.status === 2 && r.media?.status === 5
          ? { status: 'available', tone: 'ok' as const }
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
export type ArrData = {
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
  history: {
    title: string
    event: string
    tone: 'ok' | 'warn' | 'bad' | 'muted'
    ageDays: number | null
  }[]
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

/** How far ahead the calendar looks. Two weeks is a fortnight of evenings. */
const CALENDAR_DAYS = 14

export async function loadArr(app: 'sonarr' | 'radarr', ctx: Ctx): Promise<ArrData> {
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
        library === null ? null : library.reduce((n, i) => n + (i.statistics?.sizeOnDisk ?? 0), 0),
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
          (r.trackedDownloadStatus === 'warning' || r.trackedDownloadStatus === 'error'
            ? r.trackedDownloadStatus
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
          c.seasonNumber === undefined || c.episodeNumber === undefined
            ? null
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

/** `2026-08-06` — what the *arrs' calendar endpoint wants. */
function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/* ── Bazarr ───────────────────────────────────────────────────────────── */

export type BazarrData = {
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

export async function loadBazarr(ctx: Ctx): Promise<BazarrData> {
  const h = { headers: { 'X-API-KEY': key('BAZARR_API_KEY') } }
  const base = `${ctx.hc}:6767/api`

  const [status, eps, movies, providers, subgen] = await Promise.all([
    getJson<{
      data?: { bazarr_version?: string; sonarr_version?: string; radarr_version?: string }
    }>(`${base}/system/status`, h),
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

/* ── Recyclarr ────────────────────────────────────────────────────────── */

/**
 * Recyclarr, which lives with Sonarr and Radarr rather than with the cleaners.
 *
 * It was grouped with Cleanuparr and Janitorr on the grounds that all three are
 * timers nobody watches — true, and the wrong axis. What Recyclarr actually
 * DOES is write custom formats and scoring into the two *arrs, so its output
 * is their configuration and the page you want it next to is theirs. The
 * cleaners act on the download queue and the library instead.
 */
export type RecyclarrData = {
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

export async function loadRecyclarr(): Promise<RecyclarrData> {
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
      runStamp === null
        ? null
        : { ok: (lastRunLine ?? '').includes('job succeeded'), day: runStamp },
    errors,
    synced,
    days: CLEANUP_DAYS,
  }
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
