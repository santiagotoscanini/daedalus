// The Media category: two sub-tabs that share almost no machinery.
//
// TV is a pipeline — indexers feed a downloader, the downloader feeds the
// *arrs, the *arrs feed Jellyfin — so its page is built around where work is
// sitting right now, not around per-service counters. Books is a much smaller
// story (a library and a download queue), so it stays a set of readings.
//
// Where a number exists both in prometheus (via scraparr) and in a service's
// own API, prometheus wins for anything that is a *count* and the API wins for
// anything that is a *list*. Counts are what scraparr already collects on a
// timer, and re-asking six services for them on every page load would triple
// the fan-out to get the same integers a minute later.

import { getJson, promScalar, promScalars, promSeries, promVector, qbtCookie } from '../clients'
import { key } from '../format'

/* ── TV ───────────────────────────────────────────────────────────────── */

export type TvData = {
  nowPlaying: {
    user: string
    title: string
    sub: string | null
    pct: number | null
    paused: boolean
    device: string | null
    method: string | null
  }[]
  transfers: {
    name: string
    pct: number
    state: string
    down: number
    up: number
    etaSeconds: number | null
    size: number
    active: boolean
  }[]
  usenet: { name: string; pct: number; remainingBytes: number }[]
  speed: {
    down: number | null
    up: number | null
    sessionDown: number | null
    sessionUp: number | null
    connection: string | null
    usenetRate: number | null
    paused: boolean
  }
  pipeline: {
    indexers: number | null
    downloading: number
    importing: number | null
    wanted: number | null
    library: number | null
  }
  library: {
    movies: number | null
    series: number | null
    episodes: number | null
    usedBytes: number | null
    freeBytes: number | null
    /** 30-day history of bytes used under /s2/tv. */
    growth: number[]
  }
  wanted: {
    movies: number | null
    episodes: number | null
    subtitleEpisodes: number | null
    subtitleMovies: number | null
  }
  vpn: {
    up: boolean | null
    ip: string | null
    country: string | null
    city: string | null
    port: number | null
  }
  indexers: { label: string; value: number }[]
  /** Cleanuparr's last week, counted out of its log lines. */
  cleanup: { removed: number | null; blocked: number | null; searches: number | null }
}

export async function loadTv(ctx: {
  base: (app: string) => string
  hc: string
}): Promise<TvData> {
  const [
    sessions,
    qbt,
    nzbStatus,
    nzbGroups,
    counts,
    disk,
    growth,
    vpnIp,
    vpnPort,
    vpnUp,
    grabsByIndexer,
    indexerList,
    bazarrEps,
    bazarrMovies,
    cleanup,
  ] = await Promise.all([
    loadJellyfinSessions(ctx.base('jellyfin')),
    loadQbt(`${ctx.hc}:8090`),
    getJson<{
      result?: { DownloadRate?: number; DownloadPaused?: boolean }
    }>(`${ctx.base('nzbget')}/jsonrpc/status`),
    getJson<{
      result?: { NZBName?: string; FileSizeMB?: number; RemainingSizeMB?: number }[]
    }>(`${ctx.base('nzbget')}/jsonrpc/listgroups`),
    promScalars({
      movies: 'radarr_movies',
      series: 'sonarr_series',
      episodes: 'sonarr_episodes',
      missingEpisodes: 'sonarr_missing_episodes',
      missingMovies: 'radarr_missing_movies',
      queueSonarr: 'sonarr_queue_count',
      queueRadarr: 'radarr_queue_count',
      jellyfinMovies: 'jellyfin_number_of_movies',
    }),
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
    getJson<{ public_ip?: string; country?: string; city?: string }>(
      `${ctx.hc}:8000/v1/publicip/ip`,
    ),
    getJson<{ port?: number }>(`${ctx.hc}:8000/v1/portforward`),
    promScalar('gluetun_vpn_status'),
    promVector('topk(6, prowlarr_grabs_by_indexer)'),
    getJson<{ enable: boolean }[]>(
      `${ctx.hc}:9696/api/v1/indexer?apikey=${key('PROWLARR_API_KEY')}`,
    ),
    getJson<{ total?: number }>(`${ctx.hc}:6767/api/episodes/wanted`, {
      headers: { 'X-API-KEY': key('BAZARR_API_KEY') },
    }),
    getJson<{ total?: number }>(`${ctx.hc}:6767/api/movies/wanted`, {
      headers: { 'X-API-KEY': key('BAZARR_API_KEY') },
    }),
    loadCleanup(),
  ])

  const usenet = (nzbGroups?.result ?? []).map((g) => {
    const total = g.FileSizeMB ?? 0
    const left = g.RemainingSizeMB ?? 0
    return {
      name: g.NZBName ?? '?',
      pct: total > 0 ? ((total - left) / total) * 100 : 0,
      remainingBytes: left * 1024 * 1024,
    }
  })

  const importing = sum(counts.queueSonarr, counts.queueRadarr)
  const used = disk.size !== null && disk.avail !== null ? disk.size - disk.avail : null

  return {
    nowPlaying: sessions,
    transfers: qbt.torrents,
    usenet,
    speed: {
      down: qbt.transfer?.dl_info_speed ?? null,
      up: qbt.transfer?.up_info_speed ?? null,
      sessionDown: qbt.transfer?.dl_info_data ?? null,
      sessionUp: qbt.transfer?.up_info_data ?? null,
      connection: qbt.transfer?.connection_status ?? null,
      usenetRate: nzbStatus?.result?.DownloadRate ?? null,
      paused: nzbStatus?.result?.DownloadPaused === true,
    },
    pipeline: {
      indexers: indexerList === null ? null : indexerList.filter((i) => i.enable).length,
      downloading: qbt.torrents.filter((t) => t.active).length + usenet.length,
      importing,
      wanted: sum(counts.missingEpisodes, counts.missingMovies),
      library: sum(counts.episodes, counts.movies),
    },
    library: {
      movies: counts.movies ?? counts.jellyfinMovies,
      series: counts.series,
      episodes: counts.episodes,
      usedBytes: used,
      freeBytes: disk.avail,
      growth,
    },
    wanted: {
      movies: counts.missingMovies,
      episodes: counts.missingEpisodes,
      subtitleEpisodes: bazarrEps?.total ?? null,
      subtitleMovies: bazarrMovies?.total ?? null,
    },
    vpn: {
      up: vpnUp === null ? null : vpnUp === 1,
      ip: vpnIp?.public_ip ?? null,
      country: vpnIp?.country ?? null,
      city: vpnIp?.city ?? null,
      port: vpnPort?.port ?? null,
    },
    indexers: grabsByIndexer
      .map((r) => ({ label: r.metric.indexer ?? '?', value: Number(r.value[1]) }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value),
    cleanup,
  }
}

/** qBittorrent's transfer summary — session totals and the live rates. */
type Transfer = {
  dl_info_speed?: number
  up_info_speed?: number
  dl_info_data?: number
  up_info_data?: number
  connection_status?: string
}

/**
 * The torrent list and the transfer summary behind ONE login.
 *
 * qBittorrent's auth is a cookie handed out by a POST, and that POST is the
 * single most expensive call on this page — it is a password check against a
 * service inside gluetun's netns. Two panels want qBittorrent data; they get
 * one session between them.
 */
async function loadQbt(
  base: string,
): Promise<{ torrents: TvData['transfers']; transfer: Transfer | null }> {
  const cookie = await qbtCookie(base)
  if (cookie === null) return { torrents: [], transfer: null }
  const h = { headers: { Cookie: cookie } }

  const [list, transfer] = await Promise.all([
    getJson<
      {
        name: string
        progress: number
        state: string
        dlspeed: number
        upspeed: number
        eta: number
        size: number
      }[]
    >(`${base}/api/v2/torrents/info`, h),
    getJson<Transfer>(`${base}/api/v2/transfer/info`, h),
  ])

  const torrents = (list ?? [])
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
    }))
    // Moving first, then closest to done. A downloader page is read top-down
    // and the top should be the thing that will change while you look at it.
    .sort((a, b) => Number(b.active) - Number(a.active) || b.pct - a.pct)
    .slice(0, 10)

  return { torrents, transfer }
}

async function loadJellyfinSessions(base: string): Promise<TvData['nowPlaying']> {
  const sessions = await getJson<
    {
      UserName?: string
      DeviceName?: string
      NowPlayingItem?: {
        Name?: string
        SeriesName?: string
        RunTimeTicks?: number
        ProductionYear?: number
      }
      PlayState?: { PositionTicks?: number; IsPaused?: boolean; PlayMethod?: string }
    }[]
  >(`${base}/Sessions`, { headers: { 'X-Emby-Token': key('JELLYFIN_API_KEY') } })

  // Only sessions actually playing something: every poller that has ever asked
  // Jellyfin a question holds an idle session for a while afterwards, so the
  // raw list reports an audience that is not in the room.
  return (sessions ?? [])
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
        // "Transcode" here is the difference between a quiet box and a pegged
        // iGPU, which is why it is on the card rather than in a log.
        method: s.PlayState?.PlayMethod ?? null,
      }
    })
}

async function loadCleanup(): Promise<TvData['cleanup']> {
  const { lokiScalar } = await import('../clients')
  const over = (needle: string) =>
    lokiScalar(`sum(count_over_time({container="cleanuparr"} |= \`${needle}\` [7d])) or vector(0)`)
  const [removed, blocked, searches] = await Promise.all([
    over('Removing item with max strikes'),
    over('blocked item keeps coming back'),
    over('Replacement search triggered'),
  ])
  return { removed, blocked, searches }
}

/* ── Books ────────────────────────────────────────────────────────────── */

export type BooksData = {
  library: {
    books: number | null
    authors: number | null
    series: number | null
    categories: number | null
    usedBytes: number | null
  }
  /** Shelfmark's queue, flattened out of its per-state maps. */
  jobs: { title: string; state: string; pct: number | null }[]
  counts: { downloading: number; queued: number; done: number; errors: number } | null
}

export async function loadBooks(ctx: {
  base: (app: string) => string
  hc: string
}): Promise<BooksData> {
  const [stats, status, disk] = await Promise.all([
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
    // Keyed by state, then by job id — see stacks/shelfmark. The inner records
    // are loosely typed on purpose: the fields vary by state and only the
    // title and progress are ever present.
    getJson<Record<string, Record<string, { title?: string; progress?: number }>>>(
      `${ctx.hc}:8084/api/status`,
    ),
    promScalars({
      size: 'node_filesystem_size_bytes{mountpoint="/s2/books"}',
      avail: 'node_filesystem_avail_bytes{mountpoint="/s2/books"}',
    }),
  ])

  const bucket = (state: string) => Object.values(status?.[state] ?? {})
  const jobs = ['downloading', 'resolving', 'locating', 'queued', 'error']
    .flatMap((state) =>
      bucket(state).map((j) => ({
        title: j.title ?? 'untitled',
        state,
        pct: typeof j.progress === 'number' ? j.progress : null,
      })),
    )
    .slice(0, 12)

  return {
    library: {
      books: stats?.books ?? null,
      authors: stats?.authors ?? null,
      series: stats?.series ?? null,
      categories: stats?.categories ?? null,
      usedBytes: disk.size !== null && disk.avail !== null ? disk.size - disk.avail : null,
    },
    jobs,
    counts:
      status === null ? null : (
        {
          downloading: bucket('downloading').length,
          queued: bucket('queued').length + bucket('resolving').length + bucket('locating').length,
          done: bucket('complete').length,
          errors: bucket('error').length,
        }
      ),
  }
}

/** Add two readings, keeping null if neither could be read. */
function sum(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null
  return (a ?? 0) + (b ?? 0)
}
