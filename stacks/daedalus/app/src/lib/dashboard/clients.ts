// HTTP helpers behind the Dashboard tab's tiles.
//
// ── how a tile reaches its service ────────────────────────────────────────
//
// daedalus is deliberately NOT on traefik-net: `auth.isolated` puts it on a
// private bridge with traefik as the only other member, which is what makes it
// safe for the app to trust the `X-Forwarded-Email` header that names whoever
// runs an Apply. Homepage dials `http://jellyfin:8096` because it IS on
// traefik-net; copying that would mean joining the same bridge and handing ~50
// containers a path to the control plane's apply endpoint. So the tiles use
// three transports instead, in this order of preference:
//
//   prometheus / loki  — already reachable over the `monitoring` bridge, and
//                        the right answer whenever the number is scraped. Two
//                        tiles (MySpeed, WireGuard) use it INSTEAD of the
//                        service's own API: the numbers are identical, and it
//                        avoids both an auth bypass and WireGuard's TOTP.
//   host.containers.internal:<port>
//                      — the must-keep host ports (CLAUDE.md): everything
//                        sharing gluetun's netns, plus Home Assistant on the
//                        host netns. Same URLs homepage uses.
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
export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T | null> {
  for (const ms of ATTEMPT_MS) {
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

/** LogQL instant query — Loki's own endpoint, not Prometheus's. */
export async function lokiScalar(query: string): Promise<number | null> {
  const body = await getJson<{ data?: { result?: VectorResult[] } }>(
    `${LOKI()}/loki/api/v1/query?query=${encodeURIComponent(query)}`,
  )
  const first = body?.data?.result?.[0]
  return first ? Number(first.value[1]) : null
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
