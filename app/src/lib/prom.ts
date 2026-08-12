import { getJson } from './http'

// The Prometheus client — every PromQL read in the app goes through these.
// Reached over the `monitoring` bridge stacks/daedalus/daedalus.nix adds to
// this container; null/[] on failure per the rule in lib/http.ts.

export const PROM = () => process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'

export type VectorResult = { metric: Record<string, string>; value: [number, string] }
export type MatrixResult = { metric: Record<string, string>; values: [number, string][] }

/**
 * Escape a string landing inside a PromQL regex or label value. App names are
 * constrained to [a-z][a-z0-9_-]* by the platform, but interpolations get
 * escaped, not trusted. Exported so every module that interpolates a name
 * into PromQL uses the same rule.
 */
export function promEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Full instant-query result — for queries that return a labelled series. */
export async function promVector(query: string): Promise<VectorResult[]> {
  const body = await getJson<{ data?: { result?: VectorResult[] } }>(
    `${PROM()}/api/v1/query?query=${encodeURIComponent(query)}`,
  )
  return body?.data?.result ?? []
}

/** First sample of an instant query, as a number. */
export async function promScalar(query: string): Promise<number | null> {
  const r = await promVector(query)
  return r[0] ? Number(r[0].value[1]) : null
}

/** Several scalars in one round trip each, resolved together. */
export async function promScalars<K extends string>(
  queries: Record<K, string>,
): Promise<Record<K, number | null>> {
  const entries = Object.entries(queries) as [K, string][]
  const values = await Promise.all(entries.map(([, q]) => promScalar(q)))
  return Object.fromEntries(entries.map(([k], i) => [k, values[i] ?? null])) as Record<
    K,
    number | null
  >
}

/**
 * Range query — the shape every chart on a category page reads.
 *
 * `step` is in seconds and is the real resolution knob: most series here come
 * from a 60s exporter timer, so asking for anything finer just interpolates
 * the same samples into more points and makes a chart look busier than the
 * data is.
 */
export async function promMatrix(
  query: string,
  minutes: number,
  step: number,
): Promise<MatrixResult[]> {
  const end = Math.floor(Date.now() / 1000)
  const body = await getJson<{ data?: { result?: MatrixResult[] } }>(
    `${PROM()}/api/v1/query_range?query=${encodeURIComponent(query)}` +
      `&start=${String(end - minutes * 60)}&end=${String(end)}&step=${String(step)}`,
  )
  return body?.data?.result ?? []
}

/** A single series as bare numbers — for a sparkline, which has no axis. */
export async function promSeries(query: string, minutes: number, step: number): Promise<number[]> {
  const m = await promMatrix(query, minutes, step)
  return m[0]?.values.map(([, v]) => Number(v)) ?? []
}

/** A single series keeping its timestamps — for charts that label an axis. */
export async function promPoints(
  query: string,
  minutes: number,
  step: number,
): Promise<{ t: number; v: number }[]> {
  const m = await promMatrix(query, minutes, step)
  return m[0]?.values.map(([t, v]) => ({ t, v: Number(v) })) ?? []
}

/** Instant query → the `{label, value}` rows a bar list renders. */
export async function promBars(
  query: string,
  label: string,
  clean: (s: string) => string = (s) => s,
): Promise<{ label: string; value: number }[]> {
  const r = await promVector(query)
  return r
    .map((x) => ({ label: clean(x.metric[label] ?? '?'), value: Number(x.value[1]) }))
    .filter((x) => Number.isFinite(x.value))
    .sort((a, b) => b.value - a.value)
}
