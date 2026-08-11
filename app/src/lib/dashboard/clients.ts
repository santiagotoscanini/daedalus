// HTTP helpers behind the dashboard's panels and tiles.
//
// ── how a tile reaches its service ────────────────────────────────────────
//
// daedalus is deliberately NOT on traefik-net: `auth.isolated` puts it on a
// private bridge with traefik as the only other member, which is what makes it
// safe for the app to trust the `X-Forwarded-Email` header that names whoever
// runs an Apply. Dialling a service by container DNS would mean joining
// traefik-net and handing ~50 containers a path to the control plane's apply
// endpoint, so it reaches everything three other ways instead, in this order
// of preference:
//
//   prometheus / loki  — already reachable over the `monitoring` bridge, and
//                        the right answer whenever the number is scraped. Two
//                        tiles (MySpeed, WireGuard) use it INSTEAD of the
//                        service's own API: the numbers are identical, and it
//                        avoids both an auth bypass and WireGuard's TOTP.
//   host.containers.internal:<port>
//                      — the must-keep host ports (CLAUDE.md): everything
//                        sharing gluetun's netns, plus Home Assistant on the
//                        host netns.
//   https://<hostname> — through traefik, on the published hostname. Pi-hole's
//                        widget already worked this way; the rest are apps
//                        whose API path is either unauthenticated or on the
//                        forward-auth bypass list.
//
// ── failure is per-tile ───────────────────────────────────────────────────
//
// Every fetch here returns null / [] rather than throwing. A dashboard where
// one dead service blanks the page is worse than no dashboard: the whole point
// is to see WHICH thing is down. Tiles render "—" for a stat they could not
// read and keep their status dot, which comes from gatus.

/**
 * Per-attempt budgets, escalating — see `getJson` for what they work around.
 *
 * Escalating rather than flat because two different things can be slow and
 * they want opposite treatment. A stalled CONNECTION wants to be abandoned
 * fast, since retrying costs one round trip and succeeds; a slow RESPONSE
 * (Open WebUI's update check reaches the internet, ~500ms) wants to be waited
 * out, since retrying it just pays the same cost twice.
 *
 * Short first attempts catch the stall for a few hundred ms instead of 3s, and
 * anything that legitimately needs longer gets it on a later attempt — by which
 * point the socket is warm, so it is a real measurement of the service rather
 * than of the network path. Four rungs because the stall occasionally survives
 * two tries; the early ones are cheap enough to afford that. Worst case for a
 * genuinely dead upstream is the sum, ~5.2s.
 */
const ATTEMPT_MS = [400, 800, 1_500, 2_500]

/**
 * Loki's budget: one attempt, and a long one.
 *
 * The ladder above exists for a stalled CONNECTION, which is a rootless-netns
 * problem on published host ports. Loki is reached over the `monitoring`
 * bridge, so that failure mode does not apply to it at all — and the one it
 * DOES have is the opposite. A LogQL aggregation over every stream is genuinely
 * slow, Loki runs a small number of them at once, and this box asks it eight
 * questions to render one page. Under that load an individual query blows past
 * 400ms for no reason worth acting on.
 *
 * Retrying there is not neutral, it is harmful: each retry queues ANOTHER query
 * behind the one still running, so five slow queries became twenty and the page
 * took the full 5.2s ladder to render numbers Loki could produce in 400ms. One
 * patient attempt is both faster and kinder to the thing being measured.
 */
const LOKI_ATTEMPT_MS = [10_000]

/**
 * Identical GETs in flight at the same moment, answered once.
 *
 * A category page and the tile catalogue underneath it legitimately want the
 * same numbers — "errors in the last hour" belongs in the headline AND on the
 * Logs tile — and asking twice is pure duplicate load on the slowest upstream
 * here. Keyed by URL and cleared as soon as the request settles, so this is a
 * request-coalescer, not a cache: nothing is ever served from a previous page
 * load, and the dashboard's numbers stay as live as they were.
 */
const inFlight = new Map<string, Promise<unknown>>()

/**
 * Run `jobs` with at most `limit` in flight.
 *
 * A burst cap, not a correctness fix — the connection stall `getJson` retries
 * around happens at any concurrency, including one. This just keeps a page
 * load from opening ~34 sockets across the box at once, on a machine where
 * everything else is also running. Six is enough that a tab costs one or two
 * waves of round trips.
 */
export async function pool<T>(jobs: (() => Promise<T>)[], limit = 6): Promise<T[]> {
  const out = new Array<T>(jobs.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      const job = jobs[i]
      if (job === undefined) return
      out[i] = await job()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker))
  return out
}

export const PROM = () => process.env.PROMETHEUS_URL ?? 'http://prometheus:9090'
export const LOKI = () => process.env.LOKI_URL ?? 'http://loki:3100'

export function basicAuth(user: string | undefined, pass: string | undefined): string {
  return `Basic ${Buffer.from(`${user ?? ''}:${pass ?? ''}`).toString('base64')}`
}

/**
 * GET (or POST) JSON, or null.
 *
 * `redirect: 'manual'` is load-bearing: an oidc-gated route answers a 302 to
 * the Pocket ID authorize endpoint, and following it would parse the IdP's HTML
 * as the service's response. A redirect means "not authorized", i.e. no data.
 *
 * ── why it retries ────────────────────────────────────────────────────────
 *
 * Opening a NEW connection to a port published out of the rootless network
 * namespace occasionally hangs on the SYN and only gives up after the kernel's
 * retransmit ladder, ~10.5s. It is not load — it reproduces with a single
 * request in flight — and it is not DNS, since dialling 169.254.1.2 directly
 * does it too. One or two of the ~8 host-port origins a tab touches hit it,
 * always on the first connection; a warm keep-alive socket never does. Node
 * closes idle sockets after ~4s, so any pause between visits pays it again —
 * which is exactly the visit a person makes.
 *
 * Retrying on a short budget turns that from 6s of dead page into ~600ms. The
 * retry is only for a THROWN request: a 4xx/5xx is the service answering, and
 * asking twice would not change its mind.
 */
export function getJson<T>(
  url: string,
  init: RequestInit = {},
  attempts: number[] = ATTEMPT_MS,
): Promise<T | null> {
  // Only plain GETs are shared. Anything carrying headers, a method or a body
  // is a different request that happens to have the same URL — qBittorrent's
  // login and pi-hole's session POST both look like that.
  if (Object.keys(init).length > 0) return attempt<T>(url, init, attempts)

  const existing = inFlight.get(url)
  if (existing !== undefined) return existing as Promise<T | null>

  const p = attempt<T>(url, init, attempts).finally(() => inFlight.delete(url))
  inFlight.set(url, p)
  return p
}

/**
 * The same fetch, without the JSON.
 *
 * For the one upstream here that is not an API: the router, which answers
 * every question with a login page and states what it is in a meta tag on it.
 * Sharing `attempt`'s retry ladder matters as much as for the JSON callers —
 * this is a first connection to an address off the bridge, which is exactly
 * the case that stalls.
 */
export async function getText(
  url: string,
  attempts: number[] = ATTEMPT_MS,
): Promise<string | null> {
  for (const ms of attempts) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'manual' })
      if (!res.ok) return null
      return await res.text()
    } catch {
      // fall through to the next, longer attempt; the last one returns null
    }
  }
  return null
}

async function attempt<T>(url: string, init: RequestInit, attempts: number[]): Promise<T | null> {
  for (const ms of attempts) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(ms),
        redirect: 'manual',
        ...init,
      })
      if (!res.ok) return null
      return (await res.json()) as T
    } catch {
      // fall through to the next, longer attempt; the last one returns null
    }
  }
  return null
}

type VectorResult = { metric: Record<string, string>; value: [number, string] }
type MatrixResult = { metric: Record<string, string>; values: [number, string][] }

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

/** LogQL instant query — Loki's own endpoint, not Prometheus's. */
export async function lokiScalar(query: string): Promise<number | null> {
  const body = await getJson<{ data?: { result?: VectorResult[] } }>(
    `${LOKI()}/loki/api/v1/query?query=${encodeURIComponent(query)}`,
    {},
    LOKI_ATTEMPT_MS,
  )
  const first = body?.data?.result?.[0]
  return first ? Number(first.value[1]) : null
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

/**
 * qBittorrent's API is cookie-authenticated: POST the credentials, keep the
 * SID. Not cached across requests — the dashboard reloads at most every 30s and
 * a stale cookie would fail silently, which is exactly the kind of "the tile
 * has been wrong for a week" bug this app exists to not have.
 */
export async function qbtCookie(base: string): Promise<string | null> {
  // Hand-rolled rather than getJson: the value is in a response HEADER, and
  // the body is empty (204). Same retry, same reason.
  for (const ms of ATTEMPT_MS) {
    try {
      const res = await fetch(`${base}/api/v2/auth/login`, {
        method: 'POST',
        signal: AbortSignal.timeout(ms),
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: base },
        body: new URLSearchParams({
          username: process.env.DASH_QBT_USER ?? '',
          password: process.env.DASH_QBT_PASS ?? '',
        }),
      })
      if (!res.ok) return null
      return res.headers.get('set-cookie')?.split(';')[0] ?? null
    } catch {
      // retry
    }
  }
  return null
}

/**
 * Pi-hole v6 hands out a session id even with no password set (`api.pwhash` is
 * blank — the Pocket ID gate is the real boundary, see stacks/pihole), but the
 * stats endpoints still want the `sid` header. The POST /api/auth and the GET
 * /api/stats are both on pihole's forward-auth bypass rule.
 */
export async function piholeSid(base: string): Promise<string | null> {
  const body = await getJson<{ session?: { sid: string | null } }>(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '' }),
  })
  return body?.session?.sid ?? null
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
  const end = Date.now() * 1e6
  const start = end - minutes * 60 * 1e9
  const body = await getJson<{ data?: { result?: { values: [string, string][] }[] } }>(
    `${LOKI()}/loki/api/v1/query_range?query=${encodeURIComponent(query)}` +
      `&start=${String(start)}&end=${String(end)}&limit=1&direction=backward`,
    {},
    LOKI_ATTEMPT_MS,
  )
  return body?.data?.result?.[0]?.values[0]?.[1] ?? null
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
  const end = Date.now() * 1e6
  const start = end - minutes * 60 * 1e9
  const body = await getJson<{ data?: { result?: { values: [string, string][] }[] } }>(
    `${LOKI()}/loki/api/v1/query_range?query=${encodeURIComponent(query)}` +
      `&start=${String(start)}&end=${String(end)}&limit=${String(limit)}&direction=backward`,
    {},
    LOKI_ATTEMPT_MS,
  )
  return (
    (body?.data?.result ?? [])
      .flatMap((s) => s.values)
      // Loki's timestamps are nanoseconds as a string; milliseconds is what
      // every consumer here wants and what survives JSON without precision loss.
      .map(([ns, line]) => ({ at: Number(ns) / 1e6, line }))
      .sort((a, b) => b.at - a.at)
  )
}
