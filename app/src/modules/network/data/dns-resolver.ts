import type { Ctx } from '../../../core/ctx'
import { networkFacts } from '../../../host/contract/domains/network'
import { versionGap } from '../../../lib/dashboard/github'
import { getJson } from '../../../lib/http'
import type { ResolverData, Upstream } from './dns'

// Network › DNS, the resolver: pi-hole's FTL, read over its own API on the
// public hostname (`base`). Every endpoint here is aggregate counts, inside the
// read-only bypass nix/modules/pihole puts in front of the gate; the reads that
// carry identities go direct instead (`PIHOLE` in shared.ts).
// fetchResolver asks every endpoint at once; the helpers under loadResolver
// turn FTL's shapes into the tab's.

type FtlUpstream = {
  ip?: string
  name?: string
  count?: number
  statistics?: { response?: number }
}

type FtlHistoryBucket = {
  timestamp: number
  total: number
  cached: number
  blocked: number
  forwarded: number
}

/** Every FTL endpoint the tab reads, in one parallel round. Each is null when FTL did not answer. */
async function fetchResolver(base: string) {
  const [sources, summary, ftl, metrics, types, history, store, blocking] = await Promise.all([
    getJson<{
      upstreams?: FtlUpstream[]
      total_queries?: number
      forwarded_queries?: number
    }>(`${base}/api/stats/upstreams`),
    getJson<{
      queries?: { total?: number; blocked?: number; percent_blocked?: number }
      gravity?: { domains_being_blocked?: number }
    }>(`${base}/api/stats/summary`),
    getJson<{
      ftl?: {
        clients?: { total?: number; active?: number }
        query_frequency?: number
        database?: { domains?: { allowed?: { total?: number }; denied?: { total?: number } } }
      }
    }>(`${base}/api/info/ftl`),
    getJson<{
      metrics?: {
        dns?: {
          cache?: { size?: number; inserted?: number; evicted?: number; expired?: number }
        }
      }
    }>(`${base}/api/info/metrics`),
    getJson<{ types?: Record<string, number> }>(`${base}/api/stats/query_types`),
    getJson<{ history?: FtlHistoryBucket[] }>(`${base}/api/history`),
    getJson<{ size?: number; queries_disk?: number; earliest_timestamp_disk?: number }>(
      `${base}/api/info/database`,
    ),
    getJson<{ blocking?: string; timer?: number | null }>(`${base}/api/dns/blocking`),
  ])
  return { sources, summary, ftl, metrics, types, history, store, blocking }
}

export async function loadResolver(ctx: Ctx, base: string): Promise<ResolverData> {
  const version = ctx.env('PIHOLE_VERSION') ?? null

  const declared = (await networkFacts()).dnsUpstreams

  const [gap, r] = await Promise.all([versionGap('pi-hole/FTL', version), fetchResolver(base)])
  const { summary, ftl, blocking } = r
  const rows = r.sources?.upstreams ?? []
  const total = r.sources?.total_queries ?? null
  const cache = r.metrics?.metrics?.dns?.cache

  return {
    version,
    gap,
    blocking: {
      on: blocking?.blocking === undefined ? null : blocking.blocking === 'enabled',
      resumesIn: blocking?.timer ?? null,
    },
    answered: answeredSplit(rows, total, r.sources?.forwarded_queries ?? 0),
    queries: {
      total,
      perSecond: ftl?.ftl?.query_frequency ?? null,
      blockedPct: summary?.queries?.percent_blocked ?? null,
    },
    clients: { total: ftl?.ftl?.clients?.total ?? null, active: ftl?.ftl?.clients?.active ?? null },
    lists: {
      gravity: summary?.gravity?.domains_being_blocked ?? null,
      allowed: ftl?.ftl?.database?.domains?.allowed?.total ?? null,
      denied: ftl?.ftl?.database?.domains?.denied?.total ?? null,
    },
    cache: {
      size: cache?.size ?? null,
      inserted: cache?.inserted ?? null,
      evicted: cache?.evicted ?? null,
      expired: cache?.expired ?? null,
    },
    upstreams: upstreamRows(rows, declared),
    types: queryTypes(r.types?.types ?? {}),
    history: hourly(r.history?.history ?? []),
    store: {
      queries: r.store?.queries_disk ?? null,
      sinceSeconds:
        r.store?.earliest_timestamp_disk === undefined
          ? null
          : Date.now() / 1000 - r.store.earliest_timestamp_disk,
      bytes: r.store?.size ?? null,
    },
  }
}

/** The four ways a query ended, from the upstreams endpoint's counts. */
function answeredSplit(
  rows: FtlUpstream[],
  total: number | null,
  forwarded: number,
): ResolverData['answered'] {
  const countOf = (ip: string) => rows.find((u) => u.ip === ip)?.count ?? 0
  const cached = countOf('cache')
  const blocked = countOf('blocklist')

  // Everything FTL answered from neither the cache, the blocklist, nor an
  // upstream: the hosts file and the DHCP lease table. It is the share that
  // makes `<app>.<baseDomain>` an address without leaving the house, so it is
  // worth naming rather than folding into "cached".
  const local = total === null ? 0 : Math.max(0, total - cached - blocked - forwarded)

  return { local, cached, forwarded, blocked }
}

/** The resolvers queries were forwarded to, busiest first. */
function upstreamRows(rows: FtlUpstream[], declared: readonly string[]): Upstream[] {
  return (
    rows
      // `cache` and `blocklist` arrive in the same list and are not resolvers
      // — they are two of the ways a query never left the box, and are
      // counted in `answered` above.
      .filter((u) => u.ip !== undefined && u.ip !== 'cache' && u.ip !== 'blocklist')
      .map((u) => ({
        ip: u.ip ?? '',
        name: u.name ?? '',
        count: u.count ?? 0,
        replyMs:
          u.statistics?.response === undefined || u.statistics.response === 0
            ? null
            : u.statistics.response * 1000,
        declared: declared.includes(u.ip ?? ''),
      }))
      .sort((a, b) => b.count - a.count)
  )
}

/** Query types that were asked at all, most asked first. */
function queryTypes(types: Record<string, number>): ResolverData['types'] {
  return Object.entries(types)
    .filter(([, v]) => v > 0)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
}

/**
 * FTL's ten-minute buckets, summed into hours.
 *
 * 144 columns across a panel is a texture, not a chart — at this width each
 * one would be under two pixels. An hour is also the honest resolution for the
 * question the chart answers ("when is this house awake"), and the buckets are
 * counts, so summing them is exact rather than a resample.
 */
function hourly(raw: FtlHistoryBucket[]): ResolverData['history'] {
  const by = new Map<number, { total: number; blocked: number; forwarded: number }>()
  for (const b of raw) {
    const hour = Math.floor(b.timestamp / 3600) * 3600
    const acc = by.get(hour) ?? { total: 0, blocked: 0, forwarded: 0 }
    acc.total += b.total
    acc.blocked += b.blocked
    acc.forwarded += b.forwarded
    by.set(hour, acc)
  }

  return (
    [...by]
      .sort((a, b) => a[0] - b[0])
      // FTL's window is a rolling 24 hours, so the oldest hour is a fragment of
      // one — a stub column that reads as a quiet spell rather than as an
      // artefact of where the window happens to start. The newest is also
      // partial, and that one stays: "so far this hour" is what a live chart is
      // supposed to show.
      .slice(-24)
      .map(([hour, v]) => ({
        // Formatted on the SERVER, like every other relative time on this
        // dashboard: a Date read during render disagrees between the streamed
        // HTML and the hydrated tree and React discards the whole subtree.
        label: new Date(hour * 1000).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        ...v,
      }))
  )
}
