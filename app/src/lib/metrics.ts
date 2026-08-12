import { lokiScalar, lokiStreams } from './loki'
import { type MatrixResult, promEscape, promMatrix, promVector, type VectorResult } from './prom'

// The app pages' readings from Prometheus + Loki, over the shared clients in
// lib/prom.ts / lib/loki.ts (which carry the retry ladder and the one-patient-
// attempt Loki rule — this file used to hand-roll bare fetches without them).
//
// Per-container CPU/memory/pids come from the textfile exporter in
// stacks/monitoring, which reads cgroup v2 directly under
// user@1000.service. cadvisor cannot see those — it walks the system cgroup
// tree — which is why this box has no packaged container exporter and why
// these series are hand-rolled.
//
// Two consequences worth remembering when reading anything below:
//
//   Resolution is 60s, the exporter's timer. A CPU rate over a window shorter
//   than a few minutes is mostly quantisation noise, so the queries here use
//   5m and the sparklines a 2m step.
//
//   `container_memory_usage_bytes` is memory.current, which INCLUDES page
//   cache. An app doing file I/O will sit at its limit forever and be
//   perfectly healthy — the cache is reclaimed on pressure. The signal that a
//   limit is genuinely too tight is container_oom_kills_total moving, not
//   usage touching the ceiling.

export type AppStatus = {
  /** "running" | "attention" | "stopped" | "unknown" */
  state: 'running' | 'attention' | 'stopped' | 'unknown'
  /** container_up textfile metric: is the container process alive? */
  containerUp: boolean | null
  /** gatus probing the public URL from outside: is it actually serving? */
  healthy: boolean | null
  /** Requests per minute through traefik, 5m average. */
  rpm: number | null
  /** Sparkline of the same, one point per step. */
  spark: number[]
}

const EMPTY: AppStatus = {
  state: 'unknown',
  containerUp: null,
  healthy: null,
  rpm: null,
  spark: [],
}

const firstNum = (r: VectorResult[]): number | null => (r[0] ? Number(r[0].value[1]) : null)
const firstSeries = (m: MatrixResult[]): number[] =>
  m[0] ? m[0].values.map(([, v]) => Number(v)) : []

/**
 * Status for every app in one round trip per metric, rather than per app —
 * the list page renders 3 apps today but this is the query that would get
 * silly first.
 *
 * State is deliberately two signals, not one. `container_up` says the process
 * exists; gatus says it answers. An app that is up but failing its health
 * probe is the interesting case ("needs attention") and a single boolean
 * would hide it.
 */
export async function appStatuses(names: string[]): Promise<Record<string, AppStatus>> {
  const out: Record<string, AppStatus> = Object.fromEntries(names.map((n) => [n, { ...EMPTY }]))
  if (names.length === 0) return out

  const alt = names.map(promEscape).join('|')

  const [up, health, rpm, spark] = await Promise.all([
    promVector(`container_up{name=~"app-(${alt})"}`),
    promVector(`gatus_results_endpoint_success{key=~"web-apps_(${alt})"}`),
    promVector(
      `sum by (service) (rate(traefik_service_requests_total{service=~"(${alt})-svc@file"}[5m])) * 60`,
    ),
    promMatrix(
      `sum by (service) (rate(traefik_service_requests_total{service=~"(${alt})-svc@file"}[5m])) * 60`,
      60,
      120,
    ),
  ])

  for (const r of up) {
    const n = (r.metric.name ?? '').replace(/^app-/, '')
    if (out[n]) out[n].containerUp = r.value[1] === '1'
  }
  for (const r of health) {
    const n = (r.metric.key ?? '').replace(/^web-apps_/, '')
    if (out[n]) out[n].healthy = r.value[1] === '1'
  }
  for (const r of rpm) {
    const n = serviceToName(r.metric.service)
    if (out[n]) out[n].rpm = Number(r.value[1])
  }
  for (const r of spark) {
    const n = serviceToName(r.metric.service)
    if (out[n]) out[n].spark = r.values.map(([, v]) => Number(v))
  }

  for (const n of names) {
    const s = out[n]
    if (!s) continue
    s.state =
      s.containerUp === null
        ? 'unknown'
        : !s.containerUp
          ? 'stopped'
          : s.healthy === false
            ? 'attention'
            : 'running'
  }

  return out
}

/** One resource dimension: what is being used, what it is allowed, history. */
export type ResourceGauge = {
  used: number | null
  /** The LIVE cgroup limit, not the declared one. null = uncapped. */
  limit: number | null
  spark: number[]
}

export type AppResources = {
  cpu: ResourceGauge
  memory: ResourceGauge
  pids: ResourceGauge
  /** Cumulative OOM kills. Non-zero means the memory cap is actually biting. */
  oomKills: number | null
}

const NO_GAUGE: ResourceGauge = { used: null, limit: null, spark: [] }

/**
 * CPU / memory / pids for one container.
 *
 * Limits are read from the cgroup rather than from the app's registry row on
 * purpose: the row says what the next rebuild WILL enforce, the cgroup says
 * what is enforcing now. Those differ for exactly as long as an edit is
 * unapplied, and a gauge captioned "512 MB" while the kernel is enforcing
 * something else would be a lie at the only moment it matters.
 */
export async function appResources(name: string): Promise<AppResources> {
  const c = `{name="app-${promEscape(name)}"}`

  const [cpu, cpuLimit, mem, memLimit, pids, pidsLimit, oom, cpuSpark, memSpark] =
    await Promise.all([
      promVector(`rate(container_cpu_usage_seconds_total${c}[5m])`),
      promVector(`container_cpu_limit_cores${c}`),
      promVector(`container_memory_usage_bytes${c}`),
      promVector(`container_memory_limit_bytes${c}`),
      promVector(`container_pids${c}`),
      promVector(`container_pids_limit${c}`),
      promVector(`container_oom_kills_total${c}`),
      promMatrix(`rate(container_cpu_usage_seconds_total${c}[5m])`, 60, 120),
      promMatrix(`container_memory_usage_bytes${c}`, 60, 120),
    ])

  return {
    cpu: { used: firstNum(cpu), limit: firstNum(cpuLimit), spark: firstSeries(cpuSpark) },
    memory: { used: firstNum(mem), limit: firstNum(memLimit), spark: firstSeries(memSpark) },
    // No sparkline: process count is a step function that spends its life
    // flat, and a flat line reads as "no data" rather than "stable".
    pids: { used: firstNum(pids), limit: firstNum(pidsLimit), spark: [] },
    oomKills: firstNum(oom),
  }
}

export const NO_RESOURCES: AppResources = {
  cpu: NO_GAUGE,
  memory: NO_GAUGE,
  pids: NO_GAUGE,
  oomKills: null,
}

/** Bytes on disk for an app's database on the shared cluster. */
export async function databaseSize(name: string): Promise<number | null> {
  return firstNum(await promVector(`pg_database_size_bytes{datname="${promEscape(name)}"}`))
}

/**
 * One app's database on the shared cluster.
 *
 * Everything comes from postgres_exporter (`app-db-exporter`), which is the
 * only way in: each app's role can reach its own database and nothing else, so
 * daedalus — which holds credentials for `daedalus` alone — cannot connect to
 * another app's database to ask. The exporter runs as a superuser inside the
 * cluster and publishes per-database counters for all of them, which is the
 * whole reason it exists.
 *
 * The consequence is that this page can show shape and traffic but never
 * schema: no table list, no row counts, no slow queries. Those need a
 * connection, and giving daedalus one to every app's data would trade a real
 * boundary for a nicer panel.
 */
export type AppDatabase = {
  sizeBytes: number | null
  /** 30 days at a 12-hour step — growth is a slow signal. */
  sizeTrend: number[]
  connections: number | null
  /** Cluster-wide ceiling, shared by every app. */
  maxConnections: number | null
  /** Per-database cap; -1 means "no limit of its own". */
  connectionLimit: number | null
  commitsPerSec: number | null
  rollbacksPerSec: number | null
  /** Share of transactions that rolled back — an application-level signal. */
  rollbackPct: number | null
  /** Share of block reads served from shared buffers rather than disk. */
  cacheHitPct: number | null
  tuples: {
    fetched: number | null
    inserted: number | null
    updated: number | null
    deleted: number | null
  }
  deadlocks: number | null
  tempBytes: number | null
  /** Every database on the cluster, so one app's size has something to mean. */
  cluster: { label: string; value: number }[]
}

export async function appDatabase(name: string): Promise<AppDatabase> {
  const d = `{datname="${promEscape(name)}"}`

  const [
    size,
    sizeTrend,
    conns,
    maxConns,
    limit,
    commits,
    rollbacks,
    hit,
    read,
    fetched,
    inserted,
    updated,
    deleted,
    deadlocks,
    tempBytes,
    cluster,
  ] = await Promise.all([
    promVector(`pg_database_size_bytes${d}`),
    promMatrix(`pg_database_size_bytes${d}`, 30 * 24 * 60, 43200),
    promVector(`pg_stat_database_numbackends${d}`),
    promVector('pg_settings_max_connections'),
    promVector(`pg_database_connection_limit${d}`),
    promVector(`rate(pg_stat_database_xact_commit${d}[10m])`),
    promVector(`rate(pg_stat_database_xact_rollback${d}[10m])`),
    promVector(`rate(pg_stat_database_blks_hit${d}[10m])`),
    promVector(`rate(pg_stat_database_blks_read${d}[10m])`),
    promVector(`rate(pg_stat_database_tup_fetched${d}[10m])`),
    promVector(`rate(pg_stat_database_tup_inserted${d}[10m])`),
    promVector(`rate(pg_stat_database_tup_updated${d}[10m])`),
    promVector(`rate(pg_stat_database_tup_deleted${d}[10m])`),
    promVector(`pg_stat_database_deadlocks${d}`),
    promVector(`pg_stat_database_temp_bytes${d}`),
    promVector('topk(10, pg_database_size_bytes)'),
  ])

  const commit = firstNum(commits)
  const rollback = firstNum(rollbacks)
  const hits = firstNum(hit)
  const reads = firstNum(read)

  return {
    sizeBytes: firstNum(size),
    sizeTrend: firstSeries(sizeTrend),
    connections: firstNum(conns),
    maxConnections: firstNum(maxConns),
    connectionLimit: firstNum(limit),
    commitsPerSec: commit,
    rollbacksPerSec: rollback,
    // Guarded rather than computed blindly: an idle database has both rates at
    // zero, and 0/0 would render "NaN%" on the calmest possible app.
    rollbackPct:
      commit === null || rollback === null || commit + rollback === 0
        ? null
        : (rollback / (commit + rollback)) * 100,
    cacheHitPct:
      hits === null || reads === null || hits + reads === 0 ? null : (hits / (hits + reads)) * 100,
    tuples: {
      fetched: firstNum(fetched),
      inserted: firstNum(inserted),
      updated: firstNum(updated),
      deleted: firstNum(deleted),
    },
    deadlocks: firstNum(deadlocks),
    tempBytes: firstNum(tempBytes),
    cluster: cluster
      .map((r) => ({ label: r.metric.datname ?? '?', value: Number(r.value[1]) }))
      .filter((r) => Number.isFinite(r.value))
      .sort((a, b) => b.value - a.value),
  }
}

export const NO_DATABASE: AppDatabase = {
  sizeBytes: null,
  sizeTrend: [],
  connections: null,
  maxConnections: null,
  connectionLimit: null,
  commitsPerSec: null,
  rollbacksPerSec: null,
  rollbackPct: null,
  cacheHitPct: null,
  tuples: { fetched: null, inserted: null, updated: null, deleted: null },
  deadlocks: null,
  tempBytes: null,
  cluster: [],
}

/**
 * The VPN an app's traffic exits through.
 *
 * An egress app borrows a gluetun container's whole network namespace, so
 * "the app's VPN" is really that gluetun instance — and every instance is
 * scraped under a prometheus job named after its container
 * (`scrapeJob ? name` in platform/gluetun-lib.nix). That naming is what lets
 * this take the container name straight off the app record instead of keeping
 * a second table of control-API ports.
 */
export type AppVpn = {
  up: boolean | null
  ip: string | null
  city: string | null
  country: string | null
  /** Only ProtonVPN's port-forwarding instances have one. */
  forwardedPort: number | null
  uptime24h: number | null
  /** 24 hours of the up/down gauge, for the strip. */
  history: number[]
}

export async function appVpn(container: string): Promise<AppVpn> {
  const j = `{job="${promEscape(container)}"}`

  const [status, info, port, uptime, history] = await Promise.all([
    promVector(`gluetun_vpn_status${j}`),
    promVector(`gluetun_vpn_infos${j}`),
    promVector(`gluetun_forwarded_ports${j}`),
    promVector(`100 * avg_over_time(gluetun_vpn_status${j}[24h])`),
    promMatrix(`gluetun_vpn_status${j}`, 24 * 60, 300),
  ])

  const up = status[0]
  const labels = info[0]?.metric
  // The port is a LABEL on a presence gauge, not a value — gluetun publishes
  // `gluetun_forwarded_ports{port="44861"} 1`, and no series at all when
  // nothing is forwarded.
  const forwarded = port[0]?.metric.port

  return {
    up: up === undefined ? null : up.value[1] === '1',
    ip: labels?.ip ?? null,
    city: labels?.city ?? null,
    country: labels?.country ?? null,
    forwardedPort: forwarded === undefined ? null : Number(forwarded),
    uptime24h: firstNum(uptime),
    history: firstSeries(history),
  }
}

export const NO_VPN: AppVpn = {
  up: null,
  ip: null,
  city: null,
  country: null,
  forwardedPort: null,
  uptime24h: null,
  history: [],
}

export type LogLine = { ts: Date; level: string | null; line: string }

/**
 * Log lines in the last hour. LogQL, so this goes to Loki's own instant-query
 * endpoint — Prometheus would reject the stream selector outright.
 */
export async function logVolume(name: string): Promise<number | null> {
  return lokiScalar(`sum(count_over_time({service_name="${name}"}[1h]))`)
}

/**
 * The live build-and-deploy stream for an app.
 *
 * Two Loki selectors merged, because the pipeline genuinely has two halves and
 * neither alone is the story:
 *
 *   `unit="app-<name>-deploy.service"` — this box pulling the new image,
 *      restarting the container and health-checking it. alloy ships the host
 *      journal (stacks/logging), so this is complete and live.
 *
 *   `service_name="gha-runner-<name>"` — the runner announcing `Running job:`
 *      and `Job … completed with result:`.
 *
 * What is deliberately NOT here is the build's step output. The Actions runner
 * writes that to its _diag files and streams it straight to GitHub; the
 * container's stdout only ever carries those two lifecycle lines. Verified
 * against 30 days of history — everything else in that stream is runner
 * registration. Step-level progress comes from the CI snapshot instead
 * (lib/ci.ts), and the full text lives behind the Actions link.
 */
export type ActivityLine = LogLine & { source: 'build' | 'deploy' }

export async function activityLog(name: string, limit = 60, hours = 6): Promise<ActivityLine[]> {
  // Two queries, not one. LogQL's `or` combines line filters within a stream
  // selector, not two different selectors — and these are genuinely different
  // streams: the deploy unit is labelled `unit=`, the runner `service_name=`.
  // Merging in TypeScript is the honest version of what a single query would
  // only look like it was doing.
  const [deploy, build] = await Promise.all([
    lokiLines(`{unit="app-${name}-deploy.service"}`, limit, hours),
    // Only the lifecycle lines. The rest of that stream is runner
    // registration, which is noise next to a deploy.
    lokiLines(
      `{service_name="gha-runner-${name}"} |~ "(?i)(running job|job .* completed)"`,
      limit,
      hours,
    ),
  ])

  return [
    ...deploy.map((l) => ({ ...l, source: 'deploy' as const })),
    ...build.map((l) => ({ ...l, source: 'build' as const })),
  ]
    .sort((a, b) => a.ts.getTime() - b.ts.getTime())
    .slice(-limit)
}

/** Lines with their stream's `level` label — which only exists on raw streams. */
async function lokiLines(selector: string, limit: number, hours: number): Promise<LogLine[]> {
  const streams = await lokiStreams(selector, { minutes: hours * 60, limit })
  return streams.flatMap((s) =>
    s.values.map(([ns, line]) => ({
      ts: new Date(Number(BigInt(ns) / 1_000_000n)),
      level: s.stream.level ?? null,
      line,
    })),
  )
}

function serviceToName(service: string | undefined): string {
  return (service ?? '').replace(/-svc@file$/, '')
}
