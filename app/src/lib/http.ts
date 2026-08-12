// The one HTTP layer under every upstream read this app makes.
//
// ── how a page reaches a service ──────────────────────────────────────────
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
// read and keep their status dot, which comes from gatus. (The one deliberate
// exception lives in lib/access.ts, where a throw is what distinguishes "Loki
// down" from "no traffic".)

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
export const ATTEMPT_MS = [400, 800, 1_500, 2_500]

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
