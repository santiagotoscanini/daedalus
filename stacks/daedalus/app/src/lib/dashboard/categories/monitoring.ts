// The Monitoring category: the machinery that watches everything else.
//
// Its own page rather than a corner of System because it answers a different
// question. System asks "is the box healthy"; this asks "would I be told if it
// were not" — and those fail independently. A dead scrape target, a Loki that
// stopped accepting writes and a healthchecks slug nobody pings all leave the
// System page looking perfect.
//
// So every tab here is deliberately built around the GAPS: targets that are
// down get named, endpoints are ranked by their worst uptime rather than their
// average, and every dead-man's-switch is listed with how overdue it is. The
// green numbers are context; the list of things not reporting is the content.
//
// ── a tab per watcher, because they fail separately ───────────────────────
//
// One page had all five stacked, which read as one system with five panels. It
// is five systems: Grafana evaluates rules and knows nothing about whether
// prometheus is scraping; prometheus scrapes and knows nothing about whether
// Loki is ingesting; gatus probes from outside and knows nothing about either.
// The one thing they share is that when one stops, the others keep looking
// fine — which is exactly why they should not share a scroll.
//
// ── these are services, and used not to be read as any ────────────────────
//
// Every tab here carried a log and nothing else: no artwork, no version, no
// verdict on whether that version is current, no release notes. That was the
// odd one out on this dashboard — Media, Home, AI, Gaming and Network all open
// with a service head and carry a changelog — and it was odd in the direction
// that matters least defensibly, because these five ARE five pinned images
// with five release cycles. The monitoring stack was the one part of this box
// whose own upgrades were invisible from the dashboard that watches
// everything else's.
//
// Three of them report a version about themselves and two do not. That
// difference is carried through to the page rather than smoothed over: a
// number the running process stated is a measurement, and a number read off
// the tag the flake pins is only true while the tag names a release.

import { basicAuth, getJson } from '../../http'
import { key } from '../../keys'
import { lokiScalar, lokiSeries, lokiVector } from '../../loki'
import { promBars, promScalar, promScalars, promSeries, promVector } from '../../prom'
import { type VersionGap, versionGap } from '../github'
import { hostFacts, type JobRun } from '../host-facts'
import { imageVersion, type RunningVersion } from '../images'

type Ctx = { base: (app: string) => string }

/**
 * healthchecks numbers its releases with two segments — `v4.2`, `v4.1.1` — so
 * the default three-segment pattern matches none of them and would report a
 * project with 60 published releases as having none at all.
 */
const TWO_OR_THREE = /^v?(\d+\.\d+(?:\.\d+)?)$/

/**
 * Prometheus's own HTTP API, for the two things PromQL cannot answer: which
 * targets are failing and WHY, and what version the binary is. It publishes no
 * host port, so this is container DNS on the monitoring bridge.
 */
const promBase = () => process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'

export type MonitoringData =
  | ({ tab: 'alerts' } & AlertsData)
  | ({ tab: 'probes' } & ProbesData)
  | ({ tab: 'metrics' } & MetricsData)
  | ({ tab: 'logs' } & LogsData)
  | ({ tab: 'jobs' } & JobsData)

export async function loadMonitoring(tab: string, ctx: Ctx): Promise<MonitoringData> {
  switch (tab) {
    case 'probes':
      return { tab: 'probes', ...(await loadProbes()) }
    case 'metrics':
      return { tab: 'metrics', ...(await loadMetrics()) }
    case 'logs':
      return { tab: 'logs', ...(await loadLogs()) }
    case 'jobs':
      return { tab: 'jobs', ...(await loadJobs(ctx)) }
    default:
      return { tab: 'alerts', ...(await loadAlerts()) }
  }
}

/* ── Alerts ───────────────────────────────────────────────────────────── */

type AlertsData = {
  rules: number | null
  firing: number | null
  pending: number | null
  /** Every rule currently firing or pending, named — a count sends you hunting. */
  active: { name: string; folder: string; severity: string; summary: string }[]
  byFolder: { label: string; value: number }[]
  grafana: { dashboards: number | null; datasources: number | null; version: string | null }
  /** Where a firing alert actually goes. */
  delivery: { contactPoints: number | null; mail: boolean }
  gap: VersionGap
}

type GrafanaRule = {
  name?: string
  state?: string
  annotations?: Record<string, string>
  alerts?: { labels?: Record<string, string> }[]
}

/**
 * Grafana's ruler, not prometheus's.
 *
 * Every alert rule on this box is a Grafana-managed one — stacks/monitoring
 * provisions them from files — so prometheus's own /rules endpoint is empty
 * and would report "0 alerts" on a box with thirty.
 */
async function loadAlerts(): Promise<AlertsData> {
  const h = { headers: { Authorization: basicAuth(key('GRAFANA_USER'), key('GRAFANA_PASS')) } }

  const [body, stats, contacts, health] = await Promise.all([
    getJson<{ data?: { groups?: { file?: string; name?: string; rules?: GrafanaRule[] }[] } }>(
      'http://grafana:3000/api/prometheus/grafana/api/v1/rules',
      h,
    ),
    getJson<{ dashboards?: number; datasources?: number }>(
      'http://grafana:3000/api/admin/stats',
      h,
    ),
    getJson<unknown[]>('http://grafana:3000/api/v1/provisioning/contact-points', h),
    getJson<{ version?: string }>('http://grafana:3000/api/health', h),
  ])

  const groups = body?.data?.groups ?? []
  // `file` is the folder title in Grafana's ruler response; `name` is the
  // evaluation group inside it. The folder is the useful grouping — it is what
  // the sidebar shows and what the provisioning files are organised by.
  const flat = groups.flatMap((g) =>
    (g.rules ?? []).map((r) => ({ folder: g.file ?? '?', rule: r })),
  )

  const byFolder = new Map<string, number>()
  for (const { folder } of flat) byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1)

  // sameMajor, because Grafana maintains several release lines at once and
  // publishes them interleaved by date: 13.1.3, then 13.0.6, then 12.4.8. A box
  // on 13.x compared against the flat list is told it is behind a 12.x patch,
  // which is not an upgrade in any sense.
  const gap = await versionGap('grafana/grafana', health?.version ?? null, { sameMajor: true })

  return {
    gap,
    rules: body === null ? null : flat.length,
    firing: body === null ? null : flat.filter((r) => r.rule.state === 'firing').length,
    pending: body === null ? null : flat.filter((r) => r.rule.state === 'pending').length,
    active: flat
      .filter((r) => r.rule.state === 'firing' || r.rule.state === 'pending')
      .map(({ folder, rule }) => ({
        name: rule.name ?? '?',
        folder,
        // Severity is a label on the generated alert INSTANCE, not on the rule
        // — an inactive rule has no instances at all, which is why this is
        // only read for the active ones.
        severity: rule.alerts?.[0]?.labels?.severity ?? 'unknown',
        summary: rule.annotations?.summary ?? rule.annotations?.description ?? '',
      })),
    byFolder: [...byFolder]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    grafana: {
      dashboards: stats?.dashboards ?? null,
      datasources: stats?.datasources ?? null,
      version: health?.version ?? null,
    },
    delivery: { contactPoints: contacts?.length ?? null, mail: true },
  }
}

/* ── Probes ───────────────────────────────────────────────────────────── */

type ProbesData = {
  up: number | null
  down: number | null
  uptime24h: number | null
  /** Not answering right now, named. */
  failing: string[]
  /** Lowest 7-day uptime — ascending, because the bottom is the point. */
  worst: { name: string; uptime: number }[]
  slowest: { label: string; value: number; display: string }[]
  /** Soonest certificate expiry, and which hostname it belongs to. */
  cert: { days: number | null; host: string | null }
  /**
   * From the image, because gatus serves no version anywhere.
   *
   * `/api/v1/config` is the only unauthenticated endpoint it publishes and it
   * answers with three booleans about the login form. So the pin is the whole
   * answer here, and the page says so rather than presenting it as a reading.
   */
  running: RunningVersion
  gap: VersionGap
}

async function loadProbes(): Promise<ProbesData> {
  const running = await imageVersion('gatus')
  const [totals, current, worst, slowest, certs, gap] = await Promise.all([
    promScalars({
      up: 'count(gatus_results_endpoint_success == 1) or vector(0)',
      down: 'count(gatus_results_endpoint_success == 0) or vector(0)',
      uptime: '100 * avg(avg_over_time(gatus_results_endpoint_success[24h]))',
    }),
    promVector('gatus_results_endpoint_success == 0'),
    promVector('bottomk(8, 100 * avg_over_time(gatus_results_endpoint_success[7d]))'),
    promBars('topk(8, gatus_results_duration_seconds)', 'name'),
    promVector('bottomk(1, gatus_results_certificate_expiration_seconds)'),
    versionGap('TwiN/gatus', running.version),
  ])

  const soonest = certs[0]

  return {
    running,
    gap,
    up: totals.up,
    down: totals.down,
    uptime24h: totals.uptime,
    failing: current.map((c) => c.metric.name ?? '?').sort((a, b) => a.localeCompare(b)),
    // Re-sorted ascending: promVector preserves prometheus's order, and the
    // whole reason for a bottomk is to read the bad end first.
    worst: worst
      .map((r) => ({ name: r.metric.name ?? '?', uptime: Number(r.value[1]) }))
      .filter((r) => Number.isFinite(r.uptime))
      .sort((a, b) => a.uptime - b.uptime),
    slowest: slowest.map((s) => ({ ...s, display: `${(s.value * 1000).toFixed(0)} ms` })),
    cert: {
      days: soonest === undefined ? null : Number(soonest.value[1]) / 86400,
      host: soonest?.metric.name ?? null,
    },
  }
}

/* ── Metrics ──────────────────────────────────────────────────────────── */

type MetricsData = {
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

async function loadMetrics(): Promise<MetricsData> {
  const [targets, tsdb, seriesTrend, slowestScrapes, oldest, build] = await Promise.all([
    loadTargets(),
    promScalars({
      series: 'prometheus_tsdb_head_series',
      // Only the float stream: the histogram appender is a second series that
      // is flat zero here and would double the headline for no reason.
      samples: 'sum(rate(prometheus_tsdb_head_samples_appended_total{type="float"}[10m]))',
      storage: 'sum(prometheus_tsdb_storage_blocks_bytes)',
      retention: 'prometheus_tsdb_retention_limit_seconds',
    }),
    promSeries('prometheus_tsdb_head_series', 7 * 24 * 60, 3600),
    promBars('topk(8, scrape_duration_seconds)', 'job'),
    promScalar('prometheus_tsdb_lowest_timestamp_seconds'),
    getJson<{ data?: { version?: string } }>(`${promBase()}/api/v1/status/buildinfo`),
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
  }>(`${promBase()}/api/v1/targets?state=any`)

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

/* ── Logs ─────────────────────────────────────────────────────────────── */

type LogsData = {
  lines1h: number | null
  ingestRate: number | null
  byLevel: { label: string; value: number }[]
  volumeHistory: number[]
  errorHistory: number[]
  noisiest: { label: string; value: number }[]
  /** Which stack label each line lands under — the coverage question. */
  byStack: { label: string; value: number }[]
  /** Containers whose lines land under no registered stack. */
  unregistered: number | null
  /**
   * Two versions, because this tab has two subjects.
   *
   * Loki stores and answers; alloy tails journald and ships. They are separate
   * projects on separate release cycles, and the usual failure — lines stop
   * arriving — is as likely to be one as the other. Naming only the store
   * would leave the half that actually touches the journal unversioned.
   */
  loki: { version: string | null; gap: VersionGap }
  alloy: { running: RunningVersion; gap: VersionGap }
}

function loadLogVolume(): Promise<number | null> {
  return lokiScalar('sum(count_over_time({level=~".+"}[1h])) or vector(0)')
}

/** Loki's own base URL — bridge-only, like prometheus. */
const lokiBase = () => process.env.LOKI_URL ?? 'http://loki:3100'

async function loadLogs(): Promise<LogsData> {
  const alloyRunning = await imageVersion('alloy')

  const [
    lines1h,
    ingestRate,
    byLevel,
    volumeHistory,
    errorHistory,
    noisiest,
    byStack,
    adhoc,
    lokiBuild,
    alloyGap,
  ] = await Promise.all([
    loadLogVolume(),
    promScalar('sum(rate(loki_distributor_bytes_received_total[10m]))'),
    lokiVector('sum by (level) (count_over_time({level=~".+"}[1h]))', 'level'),
    lokiSeries('sum(count_over_time({level=~".+"}[1h]))', 24 * 60, 3600),
    lokiSeries('sum(count_over_time({level="error"}[1h]))', 24 * 60, 3600),
    lokiVector('topk(8, sum by (container) (count_over_time({level="error"}[24h])))', 'container'),
    lokiVector('topk(10, sum by (stack) (count_over_time({stack=~".+"}[24h])))', 'stack'),
    lokiScalar('sum(count_over_time({stack="adhoc"}[24h])) or vector(0)'),
    getJson<{ version?: string }>(`${lokiBase()}/loki/api/v1/status/buildinfo`),
    versionGap('grafana/alloy', alloyRunning.version),
  ])

  const lokiVersion = lokiBuild?.version ?? null

  return {
    loki: {
      version: lokiVersion,
      // Same interleaved release lines as Grafana's own repo — 3.7.x and
      // 3.6.x are cut alternately — but both share a major, so sameMajor
      // buys nothing here and cmp() orders them correctly on its own.
      gap: await versionGap('grafana/loki', lokiVersion),
    },
    alloy: { running: alloyRunning, gap: alloyGap },
    lines1h,
    ingestRate,
    byLevel,
    volumeHistory,
    errorHistory,
    // Lines from the host journal carry `unit`, not `container`, so they group
    // under an empty label. Naming that group beats rendering a bare "?" as
    // though a container were missing.
    noisiest: noisiest.map((n) => (n.label === '?' ? { ...n, label: 'host units' } : n)),
    byStack,
    unregistered: adhoc,
  }
}

/* ── Jobs ─────────────────────────────────────────────────────────────── */

/**
 * Every scheduled job, and whether anything would notice it stopping.
 *
 * This is the tab that gains most from the split, because the two halves of
 * the answer used to live on different pages: healthchecks' roster was a tile
 * here, and the registry that says which jobs were MEANT to be watched was
 * nowhere at all. Joined, the interesting row is a job declared with a
 * healthchecks slug that healthchecks has never heard of — a dead-man's-switch
 * that was armed in nix and never fired once.
 *
 * The distinction the registry carries and neither system knows:
 *   - `email`  → a run that FAILS sends mail.
 *   - `slug`   → a run that stops HAPPENING pages through healthchecks.
 * A job with mail and no slug cannot report that it was never started, which
 * is the failure mode a timer actually has.
 */
type JobsData = {
  checks: {
    name: string
    status: string
    lastPingAgo: number | null
    dueIn: number | null
    pings: number
  }[]
  summary: { up: number; down: number; late: number } | null
  jobs: {
    unit: string
    email: boolean
    slug: string | null
    /** Its healthchecks row, when the slug resolves to one. */
    status: string | null
    lastPingAgo: number | null
    /**
     * The OUTCOME, from the host snapshot's timer table — what actually
     * happened, next to the two columns about what would be noticed. Null
     * throughout for a job with no timer (boot oneshots, path units): their
     * absence from the timer list is itself information, so the row stays
     * and the columns read as dashes.
     */
    lastRunAgo: number | null
    result: string | null
    exitStatus: number | null
    nextIn: number | null
  }[]
  /** Timers running on the box that no monitoredJobs entry watches. */
  unwatchedTimers: number
  /** Declared with a slug that healthchecks does not know. */
  orphaned: string[]
  /** Watched by mail only — cannot report never having run. */
  emailOnly: number
  /** From the image: healthchecks' API is about checks, not about itself. */
  running: RunningVersion
  gap: VersionGap
}

type HcCheck = {
  name?: string
  slug?: string
  status?: string
  last_ping?: string | null
  next_ping?: string | null
  n_pings?: number
}

async function loadJobs(ctx: Ctx): Promise<JobsData> {
  const { monitoredJobs } = await import('../../nix-manifest')
  const running = await imageVersion('healthchecks')

  const [body, registry, gap, facts] = await Promise.all([
    getJson<{ checks?: HcCheck[] }>(`${ctx.base('healthchecks')}/api/v1/checks/`, {
      headers: { 'X-Api-Key': key('HEALTHCHECKS_API_KEY') },
    }),
    monitoredJobs(),
    versionGap('healthchecks/healthchecks', running.version, { tag: TWO_OR_THREE }),
    hostFacts(),
  ])

  const now = Date.now()
  const ageOf = (iso: string | null | undefined): number | null =>
    iso === null || iso === undefined ? null : (now - Date.parse(iso)) / 1000

  const checks = body?.checks
  // Keyed by slug AND by name: healthchecks derives a slug from the name, and
  // the registry declares the slug, so matching on either survives a check
  // whose display name was edited in the UI.
  const bySlug = new Map<string, HcCheck>()
  for (const c of checks ?? []) {
    if (c.slug !== undefined) bySlug.set(c.slug, c)
    if (c.name !== undefined) bySlug.set(c.name, c)
  }

  // The registry names bare units ("minecraft-backup"); the snapshot names
  // real ones ("minecraft-backup.timer" activating "…-backup.service").
  // Indexed under both stripped forms so a job matches whichever side of the
  // timer→service pair shares its name.
  const runByUnit = new Map<string, JobRun>()
  for (const r of facts.jobs) {
    runByUnit.set(r.timer.replace(/\.timer$/, ''), r)
    if (r.service !== null) runByUnit.set(r.service.replace(/\.service$/, ''), r)
  }

  const jobs = [...registry]
    .map((j) => {
      const hit = j.slug === null ? undefined : bySlug.get(j.slug)
      const run = runByUnit.get(j.unit)
      return {
        unit: j.unit,
        email: j.email,
        slug: j.slug,
        status: hit?.status ?? null,
        lastPingAgo: ageOf(hit?.last_ping),
        lastRunAgo: run === undefined || run.lastAt === null ? null : now / 1000 - run.lastAt,
        // Meaningless without a run to describe — systemd defaults them to
        // success/0 on a service that never started.
        result: run === undefined || run.lastAt === null ? null : run.result,
        exitStatus: run === undefined || run.lastAt === null ? null : run.exitStatus,
        nextIn: run?.nextAt === undefined || run.nextAt === null ? null : run.nextAt - now / 1000,
      }
    })
    // Jobs with a live dead-man's-switch first, then the mail-only ones —
    // which is the order of how much is actually known about each.
    .sort(
      (a, b) => Number(b.slug !== null) - Number(a.slug !== null) || a.unit.localeCompare(b.unit),
    )

  return {
    running,
    gap,
    summary:
      checks === undefined
        ? null
        : {
            up: checks.filter((c) => c.status === 'up').length,
            down: checks.filter((c) => c.status === 'down').length,
            late: checks.filter((c) => c.status === 'grace').length,
          },
    checks: (checks ?? [])
      .map((c) => ({
        name: c.name ?? '?',
        status: c.status ?? 'unknown',
        lastPingAgo: ageOf(c.last_ping),
        // Negative means the window has already passed — the check is overdue
        // but still inside its grace period, which is precisely the state
        // worth seeing before it turns into an alert.
        dueIn:
          c.next_ping === null || c.next_ping === undefined
            ? null
            : (Date.parse(c.next_ping) - now) / 1000,
        pings: c.n_pings ?? 0,
      }))
      // Anything not "up" first, then soonest due — the order you would read
      // them in if you were deciding whether to act.
      .sort((a, b) => {
        const rank = (s: string) => (s === 'down' ? 0 : s === 'grace' ? 1 : 2)
        return rank(a.status) - rank(b.status) || (a.dueIn ?? Infinity) - (b.dueIn ?? Infinity)
      }),
    orphaned: jobs.filter((j) => j.slug !== null && j.status === null).map((j) => j.unit),
    emailOnly: jobs.filter((j) => j.slug === null).length,
    unwatchedTimers: facts.jobs.filter((r) => {
      const base = r.timer.replace(/\.timer$/, '')
      return !registry.some((j) => j.unit === base)
    }).length,
    jobs,
  }
}
