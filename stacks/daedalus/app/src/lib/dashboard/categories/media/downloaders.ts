import { ATTEMPT_MS, getJson, getText } from '../../../http'
import { promScalars } from '../../../prom'
import { type VersionGap, versionGap } from '../../github'
import { imageTag, imageVersion, type RunningVersion } from '../../images'
import type { Ctx } from './shared'

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
export type DownloadsData = {
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

export async function loadDownloads(ctx: Ctx): Promise<DownloadsData> {
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
  const metubeVer = await imageTag('metube')
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
        shelfmarkStatus === null
          ? null
          : {
              downloading: bucket('downloading').length,
              queued:
                bucket('queued').length + bucket('resolving').length + bucket('locating').length,
              done: bucket('complete').length,
              errors: bucket('error').length,
            },
    },
    vpn: {
      up: vpnUp.up === null ? null : vpnUp.up === 1,
      country: vpnIp?.country ?? null,
      port: vpnPort?.port ?? null,
    },
  }
}

/**
 * qBittorrent's API is cookie-authenticated: POST the credentials, keep the
 * SID. Not cached across requests — the dashboard reloads at most every 30s
 * and a stale cookie would fail silently, which is exactly the kind of "the
 * tile has been wrong for a week" bug this app exists to not have. Lives here
 * rather than in lib/http.ts because qBittorrent is this tab's upstream and
 * nobody else's.
 */
async function qbtCookie(base: string): Promise<string | null> {
  // Hand-rolled rather than getJson: the value is in a response HEADER, and
  // the body is empty (204). Same retry, same reason.
  for (const ms of ATTEMPT_MS) {
    try {
      const res = await fetch(`${base}/api/v2/auth/login`, {
        method: 'POST',
        signal: AbortSignal.timeout(ms),
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: base },
        body: new URLSearchParams({
          username: process.env.DASH_QBT_USER ?? '',
          password: process.env.DASH_QBT_PASS ?? '',
        }),
      })
      if (!res.ok) return null
      return res.headers.get('set-cookie')?.split(';')[0] ?? null
    } catch {
      // retry
    }
  }
  return null
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

/** NZBGet reports every size in whole megabytes. */
function mb(v: number | undefined): number | null {
  return v === undefined ? null : v * 1024 * 1024
}
