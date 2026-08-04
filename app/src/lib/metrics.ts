// Prometheus + Loki clients. Reached over the `monitoring` bridge that
// stacks/daedalus/daedalus.nix adds to this container.
//
// ⚠ There is no per-container CPU or memory here, and that is not an
// oversight. Rootless podman puts container cgroups under
// user.slice/user@1000.service/…, which system-level cgroup exporters cannot
// see — `container_cpu_usage_seconds_total` has zero series on this box.
// Liveness comes from the `container_up` textfile metric instead, and per-app
// throughput from traefik. Anything claiming to be a per-container CPU or
// memory figure on this dashboard would be invented, so nothing does.

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
