// The shared HTTP layer under the app's upstream reads. Not the only one: a
// caller whose answer does not fit these (qBittorrent's login lives in a
// response header) hand-rolls the fetch and reuses ATTEMPT_MS.
//
// ── how a page reaches a service ──────────────────────────────────────────
//
// daedalus is deliberately NOT on traefik-net: `auth.isolated` puts it on a
// private bridge with traefik as the only other member, which is what makes it
// safe for the app to trust the `X-Forwarded-Email` header that names the
// signed-in person (core/auth.ts). Dialling a service by container DNS would
// mean joining traefik-net and handing every container on it a path to the
// control plane, so it reaches everything three other ways instead, in this
// order of preference:
//
//   a bridge it shares — prometheus / loki over `monitoring` (litellm and pg
//                        over app-db-net, traefik's API over its own iso
//                        bridge). Prometheus is the right answer whenever the
//                        number is scraped. Two
//                        tiles (MySpeed, WireGuard) use it INSTEAD of the
//                        service's own API: the numbers are identical, and it
//                        avoids both an auth bypass and WireGuard's TOTP.
//   host.containers.internal:<port>
//                      — the must-keep host ports (CLAUDE.md): everything
//                        sharing gluetun's netns, plus Home Assistant on the
//                        host netns.
//   https://<hostname> — through traefik, on the published hostname: apps
//                        whose API path is either unauthenticated or on the
//                        forward-auth bypass list.
//
// ── failure is per-tile ───────────────────────────────────────────────────
//
// Every fetch here returns null (or a failed Result) rather than throwing. A dashboard where
// one dead service blanks the page is worse than no dashboard: the whole point
// is to see WHICH thing is down. Tiles render "—" for a stat they could not
// read and keep their status dot, which comes from gatus. (The one deliberate
// exception lives in host/access.ts, where a throw is what distinguishes "Loki
// down" from "no traffic".)

import type { Result } from './result'

/**
 * Per-attempt budgets, escalating — see `getJson` for what they work around.
 *
 * Escalating rather than flat because two different things can be slow and
 * they want opposite treatment. A stalled CONNECTION wants to be abandoned
 * fast, since retrying costs one round trip and succeeds; a slow RESPONSE
 * (Open WebUI's update check reaches the internet, ~500ms) wants to be waited
 * out, since retrying it just pays the same cost twice.
 *
 * Short first attempts cut the stall off after a few hundred ms, and
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
 * Two readers on one page can legitimately want the same number (host/loki.ts
 * reads go through getJson, and Loki is the upstream least able to afford
 * answering twice). Keyed by URL alone — the attempt ladder is not part of
 * the key — and cleared as soon as the request settles, so this is a
 * request-coalescer, not a cache: nothing is ever served from a previous page
 * load.
 */
const inFlight = new Map<string, Promise<unknown>>()

/**
 * Run `jobs` with at most `limit` in flight.
 *
 * A burst cap for the few inner fan-outs that aim a batch at ONE upstream:
 * Seerr's per-request title lookups (modules/media/data/wanted.ts, 4) and the
 * MSI support-site probes and release notes (lib/dashboard/board-releases.ts,
 * 6 and 4). Page loads themselves fan out with plain Promise.all. Not a
 * correctness fix — the connection stall `getJson` retries around happens at
 * any concurrency, including one.
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
 * does it too. It strikes one or two of the host-port origins a tab touches
 * (the Media tabs dial several inside gluetun's netns), always on the first
 * connection; a warm keep-alive socket never does. Node closes idle sockets
 * after ~4s, so any pause between visits pays it again — which is exactly the
 * visit a person makes.
 *
 * Retrying on a short budget turns that ~10.5s hang into a 400ms abort and a
 * fresh connection. The retry is only for a THROWN request (a body that fails
 * to parse included): a 4xx/5xx is the service answering, and asking twice
 * would not change its mind.
 */
export function getJson<T>(
  url: string,
  init: RequestInit = {},
  attempts: number[] = ATTEMPT_MS,
): Promise<T | null> {
  // Only plain GETs are shared. Anything carrying headers, a method or a body
  // is a different request that happens to have the same URL — qBittorrent's
  // cookie-carrying reads and pi-hole's session POST both look like that.
  if (Object.keys(init).length > 0) return attempt<T>(url, init, attempts)

  const existing = inFlight.get(url)
  if (existing !== undefined) return existing as Promise<T | null>

  const p = attempt<T>(url, init, attempts).finally(() => inFlight.delete(url))
  inFlight.set(url, p)
  return p
}

/**
 * Why a JSON read has no body.
 *
 * `status` is what the service answered with, and null when it never
 * answered. `error` then says which way it did not answer — a timeout, a
 * refused connection and a 200 whose body is not JSON are different sentences
 * to a person — in the vocabulary core/github-app.ts's `GhResult` uses for the
 * same problem. It is null exactly when there IS a status, because then the
 * service spoke for itself.
 */
type HttpFailure = {
  status: number | null
  error: 'timeout' | 'unreachable' | 'malformed' | null
}

/** What a JSON read came back as: the body, or why there is none. */
export type JsonResult<T> = Result<T, HttpFailure>

/** The abort a timed-out fetch throws, told apart from a dead connection. */
const timedOut = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')

/**
 * getJson, keeping the reason it came back empty.
 *
 * For the reads whose failure a person can act on. A token missing a
 * permission answers 401 or 403, and "the token needs X" is a different
 * sentence from "the service did not answer" — getJson folds both into null,
 * which is how a refused Cloudflare token once blanked the tunnel panels for
 * weeks without a word. Same retry ladder, same no-redirect rule; never
 * coalesced through `inFlight`, even when `init` is empty.
 */
export async function getJsonResult<T>(
  url: string,
  init: RequestInit = {},
  attempts: number[] = ATTEMPT_MS,
): Promise<JsonResult<T>> {
  // The last attempt's account of itself. `unreachable` until something
  // throws, for the degenerate case of an empty ladder.
  let error: HttpFailure['error'] = 'unreachable'
  for (const ms of attempts) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(ms),
        redirect: 'manual',
        ...init,
      })
      if (!res.ok) return { ok: false, reason: { status: res.status, error: null } }
      return { ok: true, value: (await res.json()) as T }
    } catch (e) {
      // A body that is not JSON throws here too, and is retried like a stalled
      // connection on purpose: the usual cause is a response the timeout cut
      // in half. What changes is only what the last attempt reports.
      error = e instanceof SyntaxError ? 'malformed' : timedOut(e) ? 'timeout' : 'unreachable'
    }
  }
  return { ok: false, reason: { status: null, error } }
}

/**
 * The same fetch, without the JSON.
 *
 * For the answers that are not JSON: the router's login page, which states
 * its model in a meta tag (modules/network/data/general.ts), and
 * qBittorrent's plain-text version (modules/media/data/downloaders.ts). Same
 * retry ladder and no-redirect rule as `attempt`. Takes no `init`, so it
 * cannot carry headers.
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
