import { getJson } from '../../../http'
import { key } from '../../../keys'
import { promScalars, promSeries } from '../../../prom'
import { type VersionGap, versionGap } from '../../github'
import { daysSince } from './shared'

/* ── Jellyfin ─────────────────────────────────────────────────────────── */

export type JellyfinData = {
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

export async function loadJellyfin(base: string): Promise<JellyfinData> {
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
