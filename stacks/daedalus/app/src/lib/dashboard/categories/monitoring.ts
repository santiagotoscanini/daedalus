// The Monitoring category: the machinery that watches everything else.
//
// Its own page rather than a corner of System because it answers a different
// question. System asks "is the box healthy"; this asks "would I be told if it
// were not" — and those fail independently. A dead scrape target, a Loki that
// stopped accepting writes and a healthchecks slug nobody pings all leave the
// System page looking perfect.
//
// So the page is deliberately built around the gaps: targets that are DOWN get
// named, endpoints are ranked by their WORST uptime rather than their average,
// and every dead-man's-switch is listed with how overdue it is. The green
// numbers are context; the list of things not reporting is the content.

import {
  basicAuth,
  getJson,
  lokiScalar,
  lokiSeries,
  lokiVector,
  promBars,
  promScalar,
  promScalars,
  promSeries,
  promVector,
} from '../clients'
import { key } from '../format'

export type MonitoringData = {
  alerts: {
    rules: number | null
    firing: number | null
    pending: number | null
    /** Every rule currently firing, named — a count sends you hunting. */
    active: { name: string; folder: string; severity: string; summary: string }[]
    byFolder: { label: string; value: number }[]
  }
  prometheus: {
    targetsUp: number | null
    targetsDown: number | null
    /** The targets that are not answering, with whatever they said about it. */
    down: { job: string; instance: string; error: string }[]
    series: number | null
    samplesPerSec: number | null
    storageBytes: number | null
    seriesTrend: number[]
    slowestScrapes: { label: string; value: number; display: string }[]
  }
  loki: {
    lines1h: number | null
    ingestRate: number | null
    byLevel: { label: string; value: number }[]
    volumeHistory: number[]
    errorHistory: number[]
    noisiest: { label: string; value: number }[]
  }
  probes: {
    up: number | null
    down: number | null
    uptime24h: number | null
    /** Slowest to answer right now. */
    slowest: { label: string; value: number; display: string }[]
    /** Lowest 7-day uptime — ascending, because the bottom is the point. */
    worst: { name: string; uptime: number }[]
    certSoonestDays: number | null
  }
  checks: {
    up: number
    down: number
    late: number
    list: {
      name: string
      status: string
      lastPingAgo: number | null
      dueIn: number | null
      pings: number
    }[]
  } | null
  grafana: { dashboards: number | null; datasources: number | null; alertRules: number | null }
}

export async function loadMonitoring(ctx: { base: (app: string) => string }): Promise<MonitoringData> {
  const [
    rules,
    grafana,
    targets,
    tsdb,
    seriesTrend,
    slowestScrapes,
    logs,
    byLevel,
    volumeHistory,
    errorHistory,
    noisiest,
    ingestRate,
    gatus,
    slowest,
    worst,
    certs,
    checks,
  ] = await Promise.all([
    loadRules(),
    getJson<{ dashboards?: number; datasources?: number; alerts?: number }>(
      'http://grafana:3000/api/admin/stats',
      { headers: { Authorization: basicAuth(key('GRAFANA_USER'), key('GRAFANA_PASS')) } },
    ),
    loadTargets(),
    promScalars({
      series: 'prometheus_tsdb_head_series',
      // Only the float stream: the histogram appender is a second series that
      // is flat zero here and would double the headline for no reason.
      samples: 'sum(rate(prometheus_tsdb_head_samples_appended_total{type="float"}[10m]))',
      storage: 'sum(prometheus_tsdb_storage_blocks_bytes)',
    }),
    promSeries('prometheus_tsdb_head_series', 7 * 24 * 60, 3600),
    promBars('topk(6, scrape_duration_seconds)', 'job'),
    loadLogVolume(),
    lokiVector('sum by (level) (count_over_time({level=~".+"}[1h]))', 'level'),
    lokiSeries('sum(count_over_time({level=~".+"}[1h]))', 24 * 60, 3600),
    lokiSeries('sum(count_over_time({level="error"}[1h]))', 24 * 60, 3600),
    lokiVector('topk(6, sum by (container) (count_over_time({level="error"}[24h])))', 'container'),
    promScalar('sum(rate(loki_distributor_bytes_received_total[10m]))'),
    promScalars({
      up: 'count(gatus_results_endpoint_success == 1) or vector(0)',
      down: 'count(gatus_results_endpoint_success == 0) or vector(0)',
      uptime: '100 * avg(avg_over_time(gatus_results_endpoint_success[24h]))',
    }),
    promBars('topk(6, gatus_results_duration_seconds)', 'name'),
    promVector('bottomk(6, 100 * avg_over_time(gatus_results_endpoint_success[7d]))'),
    promScalar('min(gatus_results_certificate_expiration_seconds) / 86400'),
    getJson<{ checks?: HcCheck[] }>(`${ctx.base('healthchecks')}/api/v1/checks/`, {
      headers: { 'X-Api-Key': key('HEALTHCHECKS_API_KEY') },
    }),
  ])

  return {
    alerts: rules,
    prometheus: {
      targetsUp: targets.up,
      targetsDown: targets.down,
      down: targets.list,
      series: tsdb.series,
      samplesPerSec: tsdb.samples,
      storageBytes: tsdb.storage,
      seriesTrend,
      slowestScrapes: slowestScrapes.map((s) => ({ ...s, display: `${(s.value * 1000).toFixed(0)} ms` })),
    },
    loki: {
      lines1h: logs,
      ingestRate,
      byLevel,
      volumeHistory,
      errorHistory,
      noisiest: noisiest.map((n) => (n.label === '?' ? { ...n, label: 'host units' } : n)),
    },
    probes: {
      up: gatus.up,
      down: gatus.down,
      uptime24h: gatus.uptime,
      slowest: slowest.map((s) => ({ ...s, display: `${(s.value * 1000).toFixed(0)} ms` })),
      // Re-sorted ascending: promVector preserves prometheus's order, and the
      // whole reason for a bottomk is to read the bad end first.
      worst: worst
        .map((r) => ({ name: r.metric.name ?? '?', uptime: Number(r.value[1]) }))
        .filter((r) => Number.isFinite(r.uptime))
        .sort((a, b) => a.uptime - b.uptime),
      certSoonestDays: certs,
    },
    checks: summariseChecks(checks?.checks),
    grafana: {
      dashboards: grafana?.dashboards ?? null,
      datasources: grafana?.datasources ?? null,
      alertRules: grafana?.alerts ?? null,
    },
  }
}

type GrafanaRule = {
  name?: string
  state?: string
  annotations?: Record<string, string>
  alerts?: { labels?: Record<string, string> }[]
}

/**
 * Grafana's ruler, not prometheus's — every alert rule on this box is a
 * Grafana-managed one (stacks/monitoring provisions them from files), so
 * prometheus's own /rules endpoint is empty and would report "0 alerts" on a
 * box with thirty.
 */
async function loadRules(): Promise<MonitoringData['alerts']> {
  const body = await getJson<{
    data?: { groups?: { file?: string; name?: string; rules?: GrafanaRule[] }[] }
  }>('http://grafana:3000/api/prometheus/grafana/api/v1/rules', {
    headers: { Authorization: basicAuth(key('GRAFANA_USER'), key('GRAFANA_PASS')) },
  })
  if (body === null) {
    return { rules: null, firing: null, pending: null, active: [], byFolder: [] }
  }

  const groups = body.data?.groups ?? []
  // `file` is the folder title in Grafana's ruler response; `name` is the
  // evaluation group inside it. The folder is the useful grouping — it is what
  // the sidebar shows and what the provisioning files are organised by.
  const flat = groups.flatMap((g) => (g.rules ?? []).map((r) => ({ folder: g.file ?? '?', rule: r })))

  const byFolder = new Map<string, number>()
  for (const { folder } of flat) byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1)

  return {
    rules: flat.length,
    firing: flat.filter((r) => r.rule.state === 'firing').length,
    pending: flat.filter((r) => r.rule.state === 'pending').length,
    active: flat
      .filter((r) => r.rule.state === 'firing' || r.rule.state === 'pending')
      .map(({ folder, rule }) => ({
        name: rule.name ?? '?',
        folder,
        // Severity is a label on the generated alert instance, not on the rule
        // — an inactive rule has no instances at all, which is why this is only
        // read for the firing ones.
        severity: rule.alerts?.[0]?.labels?.severity ?? 'unknown',
        summary: rule.annotations?.summary ?? rule.annotations?.description ?? '',
      })),
    byFolder: [...byFolder].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
  }
}

/**
 * Scrape targets, from prometheus's own API rather than from `up`.
 *
 * `up == 0` says a target failed; only the API carries `lastError`, which is
 * the difference between "prometheus cannot reach immich" and "immich answered
 * 401". Both read as a dead target on the graph.
 */
async function loadTargets(): Promise<{
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
  }>(`${process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'}/api/v1/targets?state=any`)

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

function loadLogVolume(): Promise<number | null> {
  return lokiScalar('sum(count_over_time({level=~".+"}[1h])) or vector(0)')
}

type HcCheck = {
  name?: string
  status?: string
  last_ping?: string | null
  next_ping?: string | null
  n_pings?: number
}

/**
 * The dead-man's-switch roster.
 *
 * Ages are computed HERE rather than shipped as timestamps: a relative time
 * derived from the browser's clock renders differently during SSR and during
 * hydration, which React reports as a mismatch and then silently re-renders.
 */
function summariseChecks(checks: HcCheck[] | undefined): MonitoringData['checks'] {
  if (checks === undefined) return null
  const now = Date.now()
  const ageOf = (iso: string | null | undefined): number | null =>
    iso === null || iso === undefined ? null : (now - Date.parse(iso)) / 1000

  return {
    up: checks.filter((c) => c.status === 'up').length,
    down: checks.filter((c) => c.status === 'down').length,
    late: checks.filter((c) => c.status === 'grace').length,
    list: checks
      .map((c) => ({
        name: c.name ?? '?',
        status: c.status ?? 'unknown',
        lastPingAgo: ageOf(c.last_ping),
        // Negative means the window has already passed — the check is overdue
        // but still inside its grace period, which is precisely the state
        // worth seeing before it turns into an alert.
        dueIn: c.next_ping === null || c.next_ping === undefined ? null : (
          (Date.parse(c.next_ping) - now) / 1000
        ),
        pings: c.n_pings ?? 0,
      }))
      // Anything not "up" first, then soonest due — the order you would read
      // them in if you were deciding whether to act.
      .sort((a, b) => {
        const rank = (s: string) => (s === 'down' ? 0 : s === 'grace' ? 1 : 2)
        return rank(a.status) - rank(b.status) || (a.dueIn ?? Infinity) - (b.dueIn ?? Infinity)
      }),
  }
}
