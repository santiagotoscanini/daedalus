import { getJson } from './http'
import type { MatrixResult, VectorResult } from './prom'

// The Loki client — every LogQL read in the app goes through these.
//
// Loki's budget is ONE attempt, and a long one. The escalating ladder in
// lib/http.ts exists for a stalled CONNECTION, which is a rootless-netns
// problem on published host ports. Loki is reached over the `monitoring`
// bridge, so that failure mode does not apply to it at all — and the one it
// DOES have is the opposite. A LogQL aggregation over every stream is
// genuinely slow, Loki runs a small number of them at once, and this box asks
// it eight questions to render one page. Under that load an individual query
// blows past 400ms for no reason worth acting on.
//
// Retrying there is not neutral, it is harmful: each retry queues ANOTHER
// query behind the one still running, so five slow queries became twenty and
// the page took the full 5.2s ladder to render numbers Loki could produce in
// 400ms. One patient attempt is both faster and kinder to the thing being
// measured. Every helper here hard-defaults to it so nobody puts Loki on the
// ladder by accident.

export const LOKI = () => process.env.LOKI_URL ?? 'http://loki:3100'

export const LOKI_ATTEMPT_MS = [10_000]

/**
 * LogQL instant query as a number. null means Loki could not be reached; an
 * empty result decodes to 0, because every instant query in this app is a
 * count/sum where "no matching lines" IS zero — rendering it as "—" made a
 * quiet hour look like an outage.
 */
export async function lokiScalar(query: string): Promise<number | null> {
  const body = await getJson<{ data?: { result?: VectorResult[] } }>(
    `${LOKI()}/loki/api/v1/query?query=${encodeURIComponent(query)}`,
    {},
    LOKI_ATTEMPT_MS,
  )
  if (body === null) return null
  const first = body.data?.result?.[0]
  return first ? Number(first.value[1]) : 0
}

/** LogQL instant query returning a labelled series, as `{label, value}` rows. */
export async function lokiVector(
  query: string,
  label: string,
): Promise<{ label: string; value: number }[]> {
  const body = await getJson<{ data?: { result?: VectorResult[] } }>(
    `${LOKI()}/loki/api/v1/query?query=${encodeURIComponent(query)}`,
    {},
    LOKI_ATTEMPT_MS,
  )
  return (body?.data?.result ?? [])
    .map((r) => ({ label: r.metric[label] ?? '?', value: Number(r.value[1]) }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => b.value - a.value)
}

/**
 * LogQL range query as bare numbers.
 *
 * Note this is genuinely a range query against Loki, NOT the same shape as
 * `promSeries` pointed at a LogQL string — prometheus cannot evaluate LogQL at
 * all, and a query that mixes them up fails as a parse error rather than as
 * something obviously wrong on screen.
 */
export async function lokiSeries(query: string, minutes: number, step: number): Promise<number[]> {
  const end = Date.now() * 1e6
  const start = end - minutes * 60 * 1e9
  const body = await getJson<{ data?: { result?: MatrixResult[] } }>(
    `${LOKI()}/loki/api/v1/query_range?query=${encodeURIComponent(query)}` +
      `&start=${String(start)}&end=${String(end)}&step=${String(step)}`,
    {},
    LOKI_ATTEMPT_MS,
  )
  return body?.data?.result?.[0]?.values.map(([, v]) => Number(v)) ?? []
}

export type LokiStream = { stream: Record<string, string>; values: [string, string][] }

/**
 * Raw matching streams from a range query, newest first per Loki's
 * `direction=backward`. The primitive under `lokiLatest` / `lokiEntries` and
 * under metrics.ts's level-tagged log readers — exposed because stream labels
 * (level, unit) only exist at this layer; every derived shape throws them
 * away.
 */
export async function lokiStreams(
  query: string,
  opts: { minutes: number; limit: number },
): Promise<LokiStream[]> {
  return (await lokiStreamsOrNull(query, opts)) ?? []
}

/**
 * As `lokiStreams`, but an unreachable Loki is `null` rather than `[]`.
 *
 * For the consumer whose subject IS silence (the mail-relay board): "no
 * matching lines" and "Loki did not answer" are its two most different
 * possible readings, and the collapsed shape above renders both as a quiet
 * month.
 */
export async function lokiStreamsOrNull(
  query: string,
  opts: { minutes: number; limit: number },
): Promise<LokiStream[] | null> {
  const end = Date.now() * 1e6
  const start = end - opts.minutes * 60 * 1e9
  const body = await getJson<{ data?: { result?: LokiStream[] } }>(
    `${LOKI()}/loki/api/v1/query_range?query=${encodeURIComponent(query)}` +
      `&start=${String(start)}&end=${String(end)}&limit=${String(opts.limit)}&direction=backward`,
    {},
    LOKI_ATTEMPT_MS,
  )
  if (body === null) return null
  return body.data?.result ?? []
}

/**
 * The most recent log LINE matching a query, as text.
 *
 * For the handful of facts a service states once at startup and nowhere an API
 * can be asked — gluetun prints the commit it was built from in its banner and
 * serves it on no endpoint this box is allowed to call. The line is already in
 * Loki, so reading it back is cheaper and less invasive than widening a
 * control-server allow list (which would restart the container).
 *
 * Newest first and limited to one: this is "what does it say now", not a
 * search. Null when nothing in the window matched — a container that has not
 * restarted inside it has genuinely not said anything.
 */
export async function lokiLatest(query: string, minutes = 60 * 24 * 30): Promise<string | null> {
  const streams = await lokiStreams(query, { minutes, limit: 1 })
  return streams[0]?.values[0]?.[1] ?? null
}

/**
 * Matching log lines with their timestamps, newest first.
 *
 * `lokiLatest` answers "what does it say"; this answers "when did it say it",
 * which is a different question and the one a history needs. Used for the two
 * things ddclient states only in its journal: every address it has published,
 * and when it last ran at all.
 */
export async function lokiEntries(
  query: string,
  minutes = 60 * 24 * 30,
  limit = 40,
): Promise<{ at: number; line: string }[]> {
  return (
    (await lokiStreams(query, { minutes, limit }))
      .flatMap((s) => s.values)
      // Loki's timestamps are nanoseconds as a string; milliseconds is what
      // every consumer here wants and what survives JSON without precision loss.
      .map(([ns, line]) => ({ at: Number(ns) / 1e6, line }))
      .sort((a, b) => b.at - a.at)
  )
}
