import { localDay } from '../../../format'
import { getJson } from '../../../http'
import { promBars, promPoints, promScalar, promScalars, promVector } from '../../../prom'
import { type VersionGap, versionGap } from '../../github'
import { clientHost, idpClients, type PocketClient } from '../idp'
import { DAYS, type TraefikRouter } from './shared'

// ── The proxy ────────────────────────────────────────

/** How a published hostname is protected, from the GATEWAY's point of view. */
export type Protection =
  /** traefik forward-auths it — nothing reaches the app unauthenticated. */
  | 'gate'
  /** The app authenticates against the IdP itself; traefik just routes. */
  | 'client'
  /** Neither. Whatever the app does about a login is the app's business. */
  | 'app'

type RouteRow = {
  host: string
  /** Also answered through the Cloudflare tunnel, i.e. from off-LAN. */
  remote: boolean
  protection: Protection
  /** The forward-auth middleware doing the gating, when one is. */
  via: string | null
  /**
   * Requests across every router on this host, over the window.
   *
   * Null rather than zero when prometheus has no series for the router at all,
   * which is a different claim — the traefik dashboard's own router carries no
   * request labels, and printing "0" beside it says nobody has opened it.
   */
  requests: number | null
  /** A router traefik parsed but refused to enable. */
  disabled: boolean
}

export type TraefikData = {
  /** What the process reports, not what the flake pinned — see /api/version. */
  version: string | null
  codename: string | null
  gap: VersionGap
  /**
   * How long the process has been up, in seconds.
   *
   * Seconds rather than the instant it started, and that is a hydration
   * decision rather than a formatting one: a duration rendered from
   * `Date.now()` in the browser disagrees with the one the server rendered,
   * and React tears the tree down over it. A number is the same on both sides.
   */
  upSeconds: number | null
  counts: {
    routers: number | null
    services: number | null
    middlewares: number | null
    /** Routers + services + middlewares traefik could not build. */
    errors: number
  }
  /** How long ago the config was last read successfully, and how often. */
  config: { reloadedAgo: number | null; reloads: number | null }
  traffic: {
    rpm: number | null
    open: number | null
    /** Requests over the window, per entrypoint — LAN against the tunnel. */
    byEntrypoint: { label: string; value: number }[]
    byService: { label: string; value: number }[]
    byCode: { label: string; value: number }[]
    daily: { date: string; requests: number }[]
    /** Backend p95 over the last hour, in ms. Mostly the APP, not the proxy. */
    p95Ms: number | null
  }
  routes: RouteRow[]
  /** How far back `daily`, `byEntrypoint` and each route's count reach. */
  windowDays: number
  /**
   * Every certificate in the store, with days left and how much it is for.
   *
   * `covers` is the join this tab exists to make: a certificate is only worth
   * renewing if some published hostname matches it, and traefik will renew one
   * forever whether or not anything does. Counted against the routing table on
   * the same page, so a zero here is a certificate nothing serves.
   */
  certs: { cn: string; sans: string[]; days: number; covers: number }[]
  /** Share of requests per negotiated TLS version, since traefik started. */
  tls: { version: string; share: number }[]
}

/**
 * traefik, and only traefik.
 *
 * The IdP used to share this page and has a category of its own now. What
 * stays is the borrow that made them worth pairing in the first place: the
 * routing table asks Pocket ID for its client list, because that list is the
 * only thing that distinguishes a router with no middleware in front of it
 * from an open door — an app doing its own OIDC has a registration, and an
 * unprotected one does not. One request, for one column.
 */
export async function loadProxy(ctx: { base: (app: string) => string }): Promise<TraefikData> {
  return loadTraefik(idpClients(ctx.base('pocket-id')))
}

/**
 * traefik, from its own API and from what prometheus scraped off it.
 *
 * The API is the only source for the routing table — the configuration
 * traefik actually built, as opposed to the one the flake asked for — and it
 * is reachable because daedalus shares a private bridge with traefik. The
 * numbers come from prometheus, which is scraping the same process.
 */
async function loadTraefik(clientsP: Promise<PocketClient[]>): Promise<TraefikData> {
  const api = 'http://traefik:8080/api'

  const [
    version,
    overview,
    routers,
    clients,
    live,
    byEntrypoint,
    byService,
    byCode,
    daily,
    p95,
    certs,
    tls,
    reload,
  ] = await Promise.all([
    getJson<{ Version?: string; Codename?: string; startDate?: string }>(`${api}/version`),
    getJson<{
      http?: Record<string, { total?: number; errors?: number }>
      tcp?: Record<string, { errors?: number }>
    }>(`${api}/overview`),
    getJson<TraefikRouter[]>(`${api}/http/routers`),
    clientsP,
    promScalars({
      rpm: 'sum(rate(traefik_entrypoint_requests_total[10m])) * 60',
      open: 'sum(traefik_open_connections)',
    }),
    // Counts over the window rather than a rate: the tunnel carries a few
    // hundred requests a day against the LAN's six figures, and at a
    // per-minute rate it rounds to zero and reads as broken.
    promBars(
      `sum by (entrypoint) (increase(traefik_entrypoint_requests_total[${DAYS}d]))`,
      'entrypoint',
    ),
    promBars(
      'topk(8, sum by (service) (rate(traefik_service_requests_total[1h]) * 60))',
      'service',
      (s) => s.replace(/-svc@file$/, ''),
    ),
    promBars('sum by (code) (increase(traefik_service_requests_total[24h]))', 'code'),
    promPoints('sum(increase(traefik_entrypoint_requests_total[1d]))', DAYS * 24 * 60, 86400),
    promScalar(
      'histogram_quantile(0.95, sum by (le) (rate(traefik_service_request_duration_seconds_bucket[1h])))',
    ),
    promVector('traefik_tls_certs_not_after'),
    promBars('sum by (tls_version) (traefik_entrypoint_requests_tls_total)', 'tls_version'),
    promScalars({
      at: 'traefik_config_last_reload_success',
      n: 'traefik_config_reloads_total',
    }),
  ])

  const requests = await promVector(
    `sum by (router) (increase(traefik_router_requests_total[${DAYS}d]))`,
  )
  const perRouter = new Map(requests.map((r) => [r.metric.router ?? '', Number(r.value[1])]))

  const nativeHosts = new Set(clients.map(clientHost).filter((h): h is string => h !== null))

  const version3 = version?.Version ?? null
  const http = overview?.http ?? {}
  const errors = ['routers', 'services', 'middlewares'].reduce(
    (n, k) => n + (http[k]?.errors ?? 0),
    0,
  )
  const tlsTotal = tls.reduce((n, t) => n + t.value, 0)
  const routes = buildRoutes(routers ?? [], perRouter, nativeHosts)

  return {
    version: version3,
    codename: version?.Codename ?? null,
    gap: await versionGap('traefik/traefik', version3),
    upSeconds:
      version?.startDate === undefined ? null : (Date.now() - Date.parse(version.startDate)) / 1000,
    counts: {
      routers: http.routers?.total ?? null,
      services: http.services?.total ?? null,
      middlewares: http.middlewares?.total ?? null,
      errors,
    },
    // The metric is an epoch, in seconds. What the panel wants is an age.
    config: {
      reloadedAgo: reload.at === null ? null : Date.now() / 1000 - reload.at,
      reloads: reload.n,
    },
    traffic: {
      rpm: live.rpm,
      open: live.open,
      byEntrypoint,
      byService,
      byCode,
      daily: daily.map((p) => ({ date: localDay(p.t * 1000), requests: p.v })),
      p95Ms: p95 === null ? null : p95 * 1000,
    },
    routes,
    windowDays: DAYS,
    certs: certs
      .map((c) => {
        // The SANs are the whole point of the wildcard: `*.toscanini.me`
        // covering every name on the box is why there is one certificate here
        // and not forty.
        const sans = (c.metric.sans ?? '').split(',').filter((s) => s !== '')
        return {
          cn: c.metric.cn ?? '?',
          sans,
          days: (Number(c.value[1]) * 1000 - Date.now()) / 86400_000,
          covers: routes.filter((r) => sans.some((s) => sanCovers(s, r.host))).length,
        }
      })
      .filter((c) => Number.isFinite(c.days))
      .sort((a, b) => a.days - b.days),
    tls:
      tlsTotal === 0
        ? []
        : tls.map((t) => ({ version: t.label, share: (t.value / tlsTotal) * 100 })),
  }
}

/**
 * Does a certificate SAN answer for a hostname.
 *
 * A wildcard matches exactly ONE label, which is the rule the whole naming
 * convention on this box rests on — `*.toscanini.me` covers `immich.…` and
 * does not cover `a.b.…`, which is why every published name is one level
 * under the apex (see the assertion in stacks/apps).
 */
function sanCovers(san: string, host: string): boolean {
  if (!san.startsWith('*.')) return san === host
  const suffix = san.slice(1)
  if (!host.endsWith(suffix)) return false
  return !host.slice(0, host.length - suffix.length).includes('.')
}

/**
 * The routing table, one row per published hostname.
 *
 * Per HOSTNAME rather than per router, because a name published both on the
 * LAN and through the tunnel is two routers for one thing — and the pair is
 * what the reader wants to see, since "reachable from outside" is a property
 * of the name rather than of either router.
 *
 * The protection is read from what traefik actually built. A forward-auth
 * middleware is unambiguous: nothing reaches the app without passing the IdP.
 * Absent one, a Pocket ID client for the same hostname means the app does its
 * own OIDC, which the gateway cannot see and does not enforce. Everything else
 * is `app` — deliberately not called "open", because Jellyfin has its own
 * login and this page has no way to know that. What it CAN say is
 * that the gateway is not the thing checking.
 */
function buildRoutes(
  routers: TraefikRouter[],
  perRouter: Map<string, number>,
  nativeHosts: Set<string>,
): RouteRow[] {
  const rows = new Map<string, RouteRow>()

  for (const r of routers) {
    // `provider === 'internal'` is traefik's own api@internal / ping — real
    // routers, but not published names, and they carry no Host rule anyway.
    const host = /Host\(`([^`]+)`\)/.exec(r.rule ?? '')?.[1]
    if (host === undefined) continue

    const oidc = (r.middlewares ?? []).find((m) => /^oidc-/.test(m))
    const row = rows.get(host) ?? {
      host,
      remote: false,
      protection: nativeHosts.has(host) ? ('client' as const) : ('app' as const),
      via: null,
      requests: null,
      disabled: false,
    }

    row.remote ||= (r.entryPoints ?? []).includes('cfweb')
    const seen = perRouter.get(r.name ?? '')
    if (seen !== undefined) row.requests = (row.requests ?? 0) + seen
    row.disabled ||= r.status !== undefined && r.status !== 'enabled'
    if (oidc !== undefined) {
      row.protection = 'gate'
      // Strip the provider suffix and the `-strip` companion's prefix: the
      // reader wants the app's name, not traefik's internal one.
      row.via = oidc.replace(/@file$/, '')
    }
    rows.set(host, row)
  }

  const order: Record<Protection, number> = { app: 0, gate: 1, client: 2 }
  return [...rows.values()].sort(
    (a, b) => order[a.protection] - order[b.protection] || a.host.localeCompare(b.host),
  )
}
