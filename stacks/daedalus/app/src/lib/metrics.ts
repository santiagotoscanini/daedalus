// Prometheus + Loki clients. Reached over the `monitoring` bridge that
// stacks/daedalus/daedalus.nix adds to this container.
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

const PROM = () => process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'
const LOKI = () => process.env.LOKI_URL ?? 'http://loki:3100'

type VectorResult = { metric: Record<string, string>; value: [number, string] }
type MatrixResult = { metric: Record<string, string>; values: [number, string][] }

async function promQuery(query: string): Promise<VectorResult[]> {
  const url = `${PROM()}/api/v1/query?query=${encodeURIComponent(query)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
  if (!res.ok) throw new Error(`prometheus HTTP ${String(res.status)}`)
  const body = (await res.json()) as { data?: { result?: VectorResult[] } }
  return body.data?.result ?? []
}

async function promRange(query: string, minutes: number, stepSeconds: number): Promise<MatrixResult[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - minutes * 60
  const url =
    `${PROM()}/api/v1/query_range?query=${encodeURIComponent(query)}` +
    `&start=${String(start)}&end=${String(end)}&step=${String(stepSeconds)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`prometheus HTTP ${String(res.status)}`)
  const body = (await res.json()) as { data?: { result?: MatrixResult[] } }
  return body.data?.result ?? []
}

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

  const alt = names.map(escapeRe).join('|')

  const [up, health, rpm, spark] = await Promise.allSettled([
    promQuery(`container_up{name=~"app-(${alt})"}`),
    promQuery(`gatus_results_endpoint_success{key=~"web-apps_(${alt})"}`),
    promQuery(`sum by (service) (rate(traefik_service_requests_total{service=~"(${alt})-svc@file"}[5m])) * 60`),
    promRange(
      `sum by (service) (rate(traefik_service_requests_total{service=~"(${alt})-svc@file"}[5m])) * 60`,
      60,
      120,
    ),
  ])

  if (up.status === 'fulfilled') {
    for (const r of up.value) {
      const n = (r.metric.name ?? '').replace(/^app-/, '')
      if (out[n]) out[n].containerUp = r.value[1] === '1'
    }
  }
  if (health.status === 'fulfilled') {
    for (const r of health.value) {
      const n = (r.metric.key ?? '').replace(/^web-apps_/, '')
      if (out[n]) out[n].healthy = r.value[1] === '1'
    }
  }
  if (rpm.status === 'fulfilled') {
    for (const r of rpm.value) {
      const n = serviceToName(r.metric.service)
      if (out[n]) out[n].rpm = Number(r.value[1])
    }
  }
  if (spark.status === 'fulfilled') {
    for (const r of spark.value) {
      const n = serviceToName(r.metric.service)
      if (out[n]) out[n].spark = r.values.map(([, v]) => Number(v))
    }
  }

  for (const n of names) {
    const s = out[n]
    if (!s) continue
    s.state =
      s.containerUp === null ? 'unknown'
      : !s.containerUp ? 'stopped'
      : s.healthy === false ? 'attention'
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
  const c = `{name="app-${escapeRe(name)}"}`

  const [cpu, cpuLimit, mem, memLimit, pids, pidsLimit, oom, cpuSpark, memSpark] =
    await Promise.allSettled([
      promQuery(`rate(container_cpu_usage_seconds_total${c}[5m])`),
      promQuery(`container_cpu_limit_cores${c}`),
      promQuery(`container_memory_usage_bytes${c}`),
      promQuery(`container_memory_limit_bytes${c}`),
      promQuery(`container_pids${c}`),
      promQuery(`container_pids_limit${c}`),
      promQuery(`container_oom_kills_total${c}`),
      promRange(`rate(container_cpu_usage_seconds_total${c}[5m])`, 60, 120),
      promRange(`container_memory_usage_bytes${c}`, 60, 120),
    ])

  const scalar = (r: PromiseSettledResult<VectorResult[]>): number | null =>
    r.status === 'fulfilled' && r.value[0] ? Number(r.value[0].value[1]) : null
  const series = (r: PromiseSettledResult<MatrixResult[]>): number[] =>
    r.status === 'fulfilled' && r.value[0] ? r.value[0].values.map(([, v]) => Number(v)) : []

  return {
    cpu: { used: scalar(cpu), limit: scalar(cpuLimit), spark: series(cpuSpark) },
    memory: { used: scalar(mem), limit: scalar(memLimit), spark: series(memSpark) },
    // No sparkline: process count is a step function that spends its life
    // flat, and a flat line reads as "no data" rather than "stable".
    pids: { used: scalar(pids), limit: scalar(pidsLimit), spark: [] },
    oomKills: scalar(oom),
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
  try {
    const r = await promQuery(`pg_database_size_bytes{datname="${name}"}`)
    return r[0] ? Number(r[0].value[1]) : null
  } catch {
    return null
  }
}

export type LogLine = { ts: Date; level: string | null; line: string }

/**
 * Recent log lines from Loki. alloy labels every `app-<name>` container with
 * service_name=<name> (stacks/logging), so no per-app config is needed.
 */
export async function recentLogs(name: string, limit = 50, days = 7): Promise<LogLine[]> {
  const query = `{service_name="${name}"}`
  const end = Date.now() * 1e6
  // 7 days, not hours. A quiet app is normal here — anansi logs its migrations
  // and "listening on", then nothing until it is restarted. A short window
  // made that look like a broken log pipeline ("Nothing in Loki") when the
  // lines were sitting in Loki the whole time, three days old. The `limit`
  // already bounds the result, so a wide window costs nothing for a chatty app
  // and is the difference between history and a blank panel for a silent one.
  const start = (Date.now() - days * 24 * 60 * 60 * 1000) * 1e6
  const url =
    `${LOKI()}/loki/api/v1/query_range?query=${encodeURIComponent(query)}` +
    `&start=${String(start)}&end=${String(end)}&limit=${String(limit)}&direction=backward`

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return []
    const body = (await res.json()) as {
      data?: { result?: { stream: Record<string, string>; values: [string, string][] }[] }
    }
    return (body.data?.result ?? [])
      .flatMap((s) =>
        s.values.map(([ns, line]) => ({
          ts: new Date(Number(BigInt(ns) / 1_000_000n)),
          level: s.stream.level ?? null,
          line,
        })),
      )
      .sort((a, b) => a.ts.getTime() - b.ts.getTime())
      .slice(-limit)
  } catch {
    return []
  }
}

/**
 * Log lines in the last hour. LogQL, so this goes to Loki's own instant-query
 * endpoint — Prometheus would reject the stream selector outright.
 */
export async function logVolume(name: string): Promise<number | null> {
  const query = `sum(count_over_time({service_name="${name}"}[1h]))`
  const url = `${LOKI()}/loki/api/v1/query?query=${encodeURIComponent(query)}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { result?: VectorResult[] } }
    const first = body.data?.result?.[0]
    return first ? Number(first.value[1]) : 0
  } catch {
    return null
  }
}

function serviceToName(service: string | undefined): string {
  return (service ?? '').replace(/-svc@file$/, '')
}

// App names are constrained to [a-z][a-z0-9_-]* by the platform, but this
// string lands inside a PromQL regex — escape rather than trust.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
