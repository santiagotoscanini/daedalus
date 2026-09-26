import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { getJson } from '../../../lib/http'

// The Metrics tab: prometheus about itself — its targets (and why the dead
// ones are dead), the TSDB's size and reach, and the binary's own version.

export type MetricsData = {
  targetsUp: number | null
  targetsDown: number | null
  /** The targets that are not answering, with whatever they said about it. */
  down: { job: string; instance: string; error: string }[]
  series: number | null
  samplesPerSec: number | null
  storageBytes: number | null
  seriesTrend: number[]
  slowestScrapes: { label: string; value: number; display: string }[]
  /** How much of the retention window is actually in the TSDB. */
  retention: { days: number | null; oldestDays: number | null }
  /** What the running binary says it is, from `/api/v1/status/buildinfo`. */
  version: string | null
  gap: VersionGap
}

export async function loadMetrics(ctx: Ctx): Promise<MetricsData> {
  const [targets, tsdb, seriesTrend, slowestScrapes, oldest, build] = await Promise.all([
    loadTargets(ctx),
    ctx.prom.scalars({
      series: 'prometheus_tsdb_head_series',
      // Only the float stream: the histogram appender is a second series that
      // is flat zero here and would double the headline for no reason.
      samples: 'sum(rate(prometheus_tsdb_head_samples_appended_total{type="float"}[10m]))',
      storage: 'sum(prometheus_tsdb_storage_blocks_bytes)',
      retention: 'prometheus_tsdb_retention_limit_seconds',
    }),
    ctx.prom.series('prometheus_tsdb_head_series', 7 * 24 * 60, 3600),
    ctx.prom.bars('topk(8, scrape_duration_seconds)', 'job'),
    ctx.prom.scalar('prometheus_tsdb_lowest_timestamp_seconds'),
    // The HTTP API again: the binary's own version is not a metric.
    getJson<{ data?: { version?: string } }>(`${ctx.prom.url()}/api/v1/status/buildinfo`),
  ])

  const version = build?.data?.version ?? null

  return {
    version,
    // No sameMajor. Prometheus also maintains an LTS line — v3.5.x releases
    // land between the 3.13.x ones — but both are major 3, so the filter would
    // not touch them; what keeps them out is that they sort BELOW what is
    // running and so are simply not "behind".
    gap: await versionGap('prometheus/prometheus', version),
    targetsUp: targets.up,
    targetsDown: targets.down,
    down: targets.list,
    series: tsdb.series,
    samplesPerSec: tsdb.samples,
    storageBytes: tsdb.storage,
    seriesTrend,
    slowestScrapes: slowestScrapes.map((s) => ({
      ...s,
      display: `${(s.value * 1000).toFixed(0)} ms`,
    })),
    retention: {
      days: tsdb.retention === null ? null : tsdb.retention / 86400,
      // How far back data ACTUALLY goes, which is the number that says whether
      // the configured window is being reached or the disk cap bit first.
      oldestDays: oldest === null ? null : (Date.now() / 1000 - oldest) / 86400,
    },
  }
}

/**
 * Scrape targets, from prometheus's own API rather than from `up`.
 *
 * `up == 0` says a target failed; only the API carries `lastError`, which is
 * the difference between "prometheus cannot reach immich" and "immich answered
 * 401". Both read as a dead target on the graph.
 */
async function loadTargets(ctx: Ctx): Promise<{
  up: number | null
  down: number | null
  list: { job: string; instance: string; error: string }[]
}> {
  const body = await getJson<{
    data?: {
      activeTargets?: {
        health: string
        lastError?: string
        labels?: Record<string, string>
        scrapePool?: string
      }[]
    }
  }>(`${ctx.prom.url()}/api/v1/targets?state=any`)

  const targets = body?.data?.activeTargets
  if (targets === undefined) return { up: null, down: null, list: [] }

  const down = targets.filter((t) => t.health !== 'up')
  return {
    up: targets.length - down.length,
    down: down.length,
    list: down.map((t) => ({
      job: t.labels?.job ?? t.scrapePool ?? '?',
      instance: t.labels?.instance ?? '?',
      error: t.lastError !== undefined && t.lastError !== '' ? t.lastError : 'no error reported',
    })),
  }
}
