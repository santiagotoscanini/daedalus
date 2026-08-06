// The Network category: everything between a packet and this box.
//
// Ordered the way traffic actually arrives — the WAN link, then the two ways
// in (Cloudflare tunnel from outside, WireGuard for us), then the proxy that
// terminates it, then the resolver every device on the LAN depends on, and
// finally the VPN the download stack exits through.
//
// Two readings here come from prometheus rather than the service's own API,
// and in both cases that is the better source rather than a fallback: MySpeed
// already exports its last test, and wg-easy v2 requires TOTP on /api/session
// so a credential login cannot work unattended at all.

import {
  getJson,
  piholeSid,
  promBars,
  promScalar,
  promScalars,
  promPoints,
  promSeries,
  promVector,
  lokiLatest,
  lokiScalar,
  lokiEntries,
} from '../clients'
import {
  commitsSince,
  versionGap,
  EMPTY_COMMITS,
  EMPTY_GAP,
  type CommitGap,
  type VersionGap,
} from '../github'
import { webAppHosts } from '../../nix-manifest'
import { key, since } from '../format'

export type NetworkTab = 'general' | 'wireguard' | 'gateway' | 'outbound'

export type NetworkData =
  | ({ tab: 'general' } & GeneralData)
  | ({ tab: 'wireguard' } & InboundData)
  | ({ tab: 'gateway' } & GatewayData)
  | ({ tab: 'outbound' } & OutboundData)

/**
 * One WireGuard peer, as wg-easy's exporter reports it.
 *
 * The handshake is the only liveness there is: WireGuard is connectionless,
 * so a peer is "connected" exactly in the sense that it exchanged a handshake
 * recently. A phone on the far side of a sleep cycle is not down.
 */
type Peer = {
  name: string
  ipv4: string | null
  enabled: boolean
  /** Null for a peer that has never completed one — see loadPeers. */
  handshakeAgo: number | null
  ago: string
  rx: number
  tx: number
}

type WireguardData = {
  version: string | null
  gap: VersionGap
  counts: { configured: number | null; enabled: number | null; connected: number | null }
  peers: Peer[]
  /** Peak simultaneous peers per day, oldest first. */
  daily: { date: string; peers: number }[]
  /**
   * Where wg-easy's UI lives, read from the nix manifest.
   *
   * Not typed out here, and the reason is that typing it out is how this page
   * shipped a link to a hostname that does not exist. Every published name is
   * already in `webAppHosts`, keyed by the webApp that owns it, so the page
   * can ask rather than remember — and a rename moves the link with it.
   */
  url: string | null
}

/** The Cloudflare tunnel, from Cloudflare's side and cloudflared's own. */
type TunnelData = {
  version: string | null
  gap: VersionGap
  status: string | null
  /** How many of the four HA connections are up, per Cloudflare. */
  connections: number | null
  /** This house's WAN address, as the edge sees it arriving. */
  originIp: string | null
  edges: { colo: string; count: number }[]
  heldForSeconds: number | null
  /** Round trip to the edge, from cloudflared's own QUIC stats. */
  rttMs: number | null
  requestsPerHour: number | null
  errors: number | null
  inFlight: number | null
  /** Requests per day through the tunnel, oldest first. */
  daily: { date: string; requests: number }[]
  /** Every hostname the tunnel will answer for — its ingress rules. */
  published: { hostname: string; service: string }[]
}

/**
 * The third way in: no proxy at all, just this house's address.
 *
 * The tunnel carries HTTP and nothing else, so anything speaking another
 * protocol has to be dialled directly — and a home connection's address
 * moves. `platform/ddclient` is what keeps a name pointed at it, and this is
 * the page that says whether it is currently pointed at the right one.
 */
type DdnsData = {
  version: string | null
  gap: VersionGap
  host: string
  /** Every N seconds ddclient re-checks, from the service definition. */
  intervalSeconds: number | null
  /** What the world resolves the name to, asked of a public resolver. */
  resolved: string | null
  ttl: number | null
  /**
   * What the address ACTUALLY is, per Cloudflare's view of the tunnel.
   *
   * The one place on this box that can answer it: everything here is behind
   * NAT and sees 192.168.0.2. Comparing the two is the whole check — a name
   * pointed at a stale address is a Factorio server nobody can join, with no
   * error anywhere.
   */
  actual: string | null
  /** When ddclient last ran, and when the timer fires next. Epoch ms. */
  lastRunAt: number | null
  nextRunAt: number | null
  /**
   * Every address this name has been pointed at, newest first.
   *
   * ddclient logs a line only when it CHANGES the record, so this is exactly
   * the change history and nothing else — no rows for the ~8,600 runs a month
   * that found nothing to do. Bounded by Loki's retention rather than by
   * choice: thirty days is all there is.
   */
  history: { at: number; ip: string; heldDays: number | null }[]
  /** ddclient runs that could not work out the address, by window. */
  lookupFailures: { day: number | null; week: number | null; month: number | null }
  /** Whether anything alerts when that happens. See fleet.monitoredJobs. */
  monitored: boolean
  /** What needs the address, from fleet.directIngress. */
  needs: { name: string; port: number; proto: string; note: string }[]
}

type InboundData = { wireguard: WireguardData; tunnel: TunnelData; ddns: DdnsData }

/**
 * One VPN egress tunnel.
 *
 * Assembled from three sources that each know something the others cannot:
 * nix (what the tunnel is for, when its key dies, where the runbook is),
 * gluetun's control API (where it currently comes out), and prometheus (how
 * reliable it has been, and what is riding it right now).
 */
type Tunnel = {
  key: string
  subject: string
  container: string
  exporter: string
  provider: string
  runbook: string
  portForwarding: boolean
  up: boolean | null
  /** Days until the WireGuard key expires. Negative once it has. */
  expiryDays: number
  keyExpiry: string
  /** Where this tunnel surfaces, from the provider's own view of it. */
  exit: {
    ip: string | null
    country: string | null
    city: string | null
    region: string | null
    org: string | null
    timezone: string | null
  }
  /** The provider-forwarded port, when this instance asks for one. */
  port: number | null
  /** Share of the last 7 days the tunnel reported itself up. */
  uptime7d: number | null
  /** Same, per day, oldest first — the shape a drop actually has. */
  daily: { date: string; uptime: number }[]
  /** Containers sharing this netns, so they lose the network with it. */
  tenants: { name: string; up: boolean | null }[]
}

type OutboundData = {
  tunnels: Tunnel[]
  /**
   * The software, which is shared by every tunnel on the page.
   *
   * Both instances come out of one `mkGluetunInstance`, which pins ONE image
   * digest for gluetun and one for the exporter — so however many tunnels are
   * declared, they are always the same two builds. Reporting it per tunnel
   * would print the same answer twice and invite the reader to check whether
   * they differ.
   */
  gluetun: CommitGap
  exporter: VersionGap
  note: string | null
}

type GeneralData = {
  wan: {
    ping: number | null
    down: number | null
    up: number | null
    /** 7 days of the hourly test, for the two trend lines. */
    downHistory: number[]
    upHistory: number[]
    pingHistory: number[]
  }
  /**
   * The headline only — one rate and one count.
   *
   * The breakdown that used to be here (top services, response codes, open
   * connections) lives on the Gateway tab now, beside the routing table those
   * numbers are about. This page is the map; that one is the proxy.
   */
  proxy: { rpm: number | null; routers: number | null; spark: number[] }
  dns: {
    queries: number | null
    blocked: number | null
    blockedPct: number | null
    gravity: number | null
    topBlocked: { label: string; value: number }[]
    topClients: { label: string; value: number }[]
  }
  tunnel: {
    status: string | null
    connections: number | null
    /** This house's WAN address, as Cloudflare's edge sees it arriving. */
    originIp: string | null
    /** Cloudflare's own name for the version cloudflared is running. */
    clientVersion: string | null
    /** Edge datacentres the four tunnel connections landed in. */
    edges: { colo: string; count: number }[]
    /** How long the oldest connection has been up — a proxy for last reconnect. */
    heldForSeconds: number | null
    requestsPerHour: number | null
  }
  wireguard: {
    connected: number | null
    enabled: number | null
    total: number | null
    peers: { name: string; handshakeAgo: number | null; rx: number | null; tx: number | null }[]
  }
  vpn: {
    up: boolean | null
    ip: string | null
    country: string | null
    city: string | null
    port: number | null
  }
}

export async function loadNetwork(
  tab: string,
  ctx: { base: (app: string) => string; hc: string },
): Promise<NetworkData> {
  switch (tab) {
    case 'wireguard':
      return { tab: 'wireguard', ...(await loadInbound(ctx)) }
    case 'gateway':
      return { tab: 'gateway', ...(await loadGateway(ctx)) }
    case 'outbound':
      return { tab: 'outbound', ...(await loadOutbound(ctx)) }
    default:
      return { tab: 'general', ...(await loadGeneral(ctx)) }
  }
}

/** How far back the two VPN tabs chart. A column per day, same as the AI tabs. */
const DAYS = 14

async function loadGeneral(ctx: {
  base: (app: string) => string
  hc: string
}): Promise<GeneralData> {
  const [
    speed,
    speedHistory,
    rpm,
    overview,
    rpmSpark,
    pihole,
    tunnel,
    wg,
    peers,
    vpnIp,
    vpnPort,
    vpnUp,
    tunnelRph,
  ] = await Promise.all([
    promScalars({ ping: 'myspeed_ping', down: 'myspeed_download', up: 'myspeed_upload' }),
    // MySpeed tests hourly, so an hourly step is the native resolution — a
    // finer one would just carry each sample forward and draw stairs.
    Promise.all([
      promSeries('myspeed_download', 7 * 24 * 60, 3600),
      promSeries('myspeed_upload', 7 * 24 * 60, 3600),
      promSeries('myspeed_ping', 7 * 24 * 60, 3600),
    ]),
    promScalar('sum(rate(traefik_service_requests_total[10m])) * 60'),
    // One number wanted out of it — the router count under the headline — and
    // it is a call to a container on the next bridge over, so it costs less
    // than the prometheus query that would half-answer it.
    getJson<{ http?: { routers?: { total?: number } } }>('http://traefik:8080/api/overview'),
    promSeries('sum(rate(traefik_service_requests_total[5m])) * 60', 6 * 60, 120),
    loadPihole(ctx.base('pihole')),
    // Cloudflare's own view of the tunnel, which is the only place the origin
    // address appears: cloudflared never learns the WAN IP it is dialling out
    // from, and neither does anything else on this box behind NAT. The edge
    // records the address the connection arrived from, so this is a free
    // answer to "what is our public IP" — from outside, which is the only
    // vantage point that can answer it truthfully.
    getJson<{ result?: CfTunnel }>(
      `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID ?? ''}/cfd_tunnel/${
        process.env.CF_TUNNEL_ID ?? ''
      }`,
      { headers: { Authorization: `Bearer ${key('CF_API_TOKEN')}` } },
    ),
    promScalars({
      connected: 'wireguard_connected_peers',
      enabled: 'wireguard_enabled_peers',
      total: 'wireguard_configured_peers',
    }),
    loadPeers(),
    getJson<{ public_ip?: string; country?: string; city?: string }>(
      `${ctx.hc}:8000/v1/publicip/ip`,
    ),
    getJson<{ port?: number }>(`${ctx.hc}:8000/v1/portforward`),
    promScalar('gluetun_vpn_status'),
    // Per HOUR over six, not per minute over ten: off-LAN traffic to this box
    // is a couple of dozen requests a day, and a per-minute rate of that is
    // indistinguishable from a tunnel carrying nothing at all.
    promScalar('sum(rate(cloudflared_tunnel_total_requests[6h])) * 3600'),
  ])

  return {
    wan: {
      ping: speed.ping,
      down: speed.down,
      up: speed.up,
      downHistory: speedHistory[0] ?? [],
      upHistory: speedHistory[1] ?? [],
      pingHistory: speedHistory[2] ?? [],
    },
    proxy: { rpm, routers: overview?.http?.routers?.total ?? null, spark: rpmSpark },
    dns: pihole,
    tunnel: summariseTunnel(tunnel?.result, tunnelRph),
    wireguard: { connected: wg.connected, enabled: wg.enabled, total: wg.total, peers },
    vpn: {
      up: vpnUp === null ? null : vpnUp === 1,
      ip: vpnIp?.public_ip ?? null,
      country: vpnIp?.country ?? null,
      city: vpnIp?.city ?? null,
      port: vpnPort?.port ?? null,
    },
  }
}

type CfTunnel = {
  status?: string
  connections?: {
    colo_name?: string
    origin_ip?: string
    opened_at?: string
    client_version?: string
  }[]
}

/**
 * The tunnel as Cloudflare sees it.
 *
 * Every connection reports the same origin address and client version — they
 * are four sessions from one cloudflared — so those are read once rather than
 * listed four times. What genuinely varies is the edge datacentre, and the
 * pairing (two connections into each of two colos) is the redundancy actually
 * in place, so that gets counted per colo.
 */
function summariseTunnel(t: CfTunnel | undefined, requestsPerHour: number | null): GeneralData['tunnel'] {
  const conns = t?.connections ?? []
  const byColo = new Map<string, number>()
  for (const c of conns) {
    const colo = c.colo_name ?? '?'
    byColo.set(colo, (byColo.get(colo) ?? 0) + 1)
  }

  const opened = conns
    .map((c) => (c.opened_at === undefined ? NaN : Date.parse(c.opened_at)))
    .filter((n) => Number.isFinite(n))

  return {
    status: t?.status ?? null,
    connections: t === undefined ? null : conns.length,
    originIp: conns[0]?.origin_ip ?? null,
    clientVersion: conns[0]?.client_version ?? null,
    edges: [...byColo].map(([colo, count]) => ({ colo, count })).sort((a, b) => b.count - a.count),
    // Oldest connection: the newest one may have re-established seconds ago
    // during a routine edge rotation, which says nothing about stability.
    heldForSeconds: opened.length === 0 ? null : (Date.now() - Math.min(...opened)) / 1000,
    requestsPerHour,
  }
}

async function loadPihole(base: string): Promise<GeneralData['dns']> {
  const sid = await piholeSid(base)
  const h = sid === null ? {} : { headers: { sid } }

  const [summary, blocked, clients] = await Promise.all([
    getJson<{
      queries?: { total?: number; blocked?: number; percent_blocked?: number }
      gravity?: { domains_being_blocked?: number }
    }>(`${base}/api/stats/summary`, h),
    getJson<{ domains?: { domain?: string; count?: number }[] }>(
      `${base}/api/stats/top_domains?blocked=true&count=6`,
      h,
    ),
    getJson<{ clients?: { name?: string; ip?: string; count?: number }[] }>(
      `${base}/api/stats/top_clients?count=6`,
      h,
    ),
  ])

  return {
    queries: summary?.queries?.total ?? null,
    blocked: summary?.queries?.blocked ?? null,
    blockedPct: summary?.queries?.percent_blocked ?? null,
    gravity: summary?.gravity?.domains_being_blocked ?? null,
    topBlocked: (blocked?.domains ?? []).map((d) => ({
      label: d.domain ?? '?',
      value: d.count ?? 0,
    })),
    // The name is often absent for devices that never announced a hostname to
    // DHCP; the address is the only identifier those have.
    topClients: (clients?.clients ?? []).map((c) => ({
      label: c.name !== undefined && c.name !== '' ? c.name : (c.ip ?? '?'),
      value: c.count ?? 0,
    })),
  }
}

async function loadPeers(): Promise<GeneralData['wireguard']['peers']> {
  const [handshake, rx, tx] = await Promise.all([
    promVector('wireguard_latest_handshake_seconds'),
    promVector('wireguard_received_bytes'),
    promVector('wireguard_sent_bytes'),
  ])

  const by = (v: typeof rx) => new Map(v.map((r) => [r.metric.name ?? '?', Number(r.value[1])]))
  const rxBy = by(rx)
  const txBy = by(tx)

  return handshake
    .map((r) => {
      const seconds = Number(r.value[1])
      return {
        name: r.metric.name ?? '?',
        // The exporter reports 0 for "never", which as an age would render as
        // "just now" — the exact opposite of what it means.
        handshakeAgo: seconds > 0 ? seconds : null,
        rx: rxBy.get(r.metric.name ?? '?') ?? null,
        tx: txBy.get(r.metric.name ?? '?') ?? null,
      }
    })
    .sort((a, b) => (a.handshakeAgo ?? Infinity) - (b.handshakeAgo ?? Infinity))
}

// ── WireGuard: the way in ──────────────────────────────────────────────────

/**
 * wg-easy, read entirely from its Prometheus endpoint.
 *
 * Not from its API, and that is a property of the software rather than a
 * shortcut: wg-easy v2 requires a TOTP code on `/api/session`, so there is no
 * unattended credential login to be had. The exporter it publishes is
 * unauthenticated on the same container and carries everything this page
 * shows — peers, their addresses, their handshakes and their byte counters.
 *
 * The version comes from nix for the same reason: nothing a read-only caller
 * can reach reports it, so the tag the image is pinned to IS the version.
 */
/**
 * All three ways in, whichever one the page is showing.
 *
 * Every route is loaded on every visit and that is deliberate: the strip above
 * the switch says which of the three is working, and a strip that only knew
 * about the selected one would be a strip nobody could trust. The switch is
 * client-side, so the server could not know which to fetch anyway.
 *
 * The Cloudflare tunnel is fetched ONCE and handed to both consumers. It
 * answers two unrelated questions — is the tunnel healthy, and what is this
 * house's WAN address — and asking twice cost a second of wall clock for the
 * same bytes. `getJson`'s coalescer cannot help: it only shares plain GETs,
 * and this one carries an Authorization header.
 */
async function loadInbound(ctx: { hc: string }): Promise<InboundData> {
  void ctx
  // Started, not awaited. Cloudflare's API is the slowest upstream this page
  // has — a second per call from here — so awaiting it before the fan-out put
  // that second in front of everything else instead of alongside it. The
  // PROMISE is handed to both consumers; each awaits it inside its own
  // Promise.all, so the one request overlaps every other query on the page.
  const cf = cfTunnel()
  const [wireguard, tunnel, ddns] = await Promise.all([
    loadWireguard(),
    loadCfTunnel(cf),
    loadDdns(cf),
  ])
  return { wireguard, tunnel, ddns }
}

/** Cloudflare's view of the tunnel. The one place the WAN address appears. */
async function cfTunnel(): Promise<CfTunnel | undefined> {
  const body = await getJson<{ result?: CfTunnel }>(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID ?? ''}/cfd_tunnel/${
      process.env.CF_TUNNEL_ID ?? ''
    }`,
    { headers: { Authorization: `Bearer ${key('CF_API_TOKEN')}` } },
  )
  return body?.result
}

async function loadWireguard(): Promise<WireguardData> {
  const version = process.env.WG_EASY_VERSION || null

  const [counts, peers, peak, hosts] = await Promise.all([
    promScalars({
      configured: "wireguard_configured_peers",
      enabled: "wireguard_enabled_peers",
      connected: "wireguard_connected_peers",
    }),
    loadWgPeers(),
    // Peak, not average: the question a household asks of a personal VPN is
    // "did anyone use it", and a peer connected for twenty minutes averages
    // to nearly nothing over a day while being the entire answer.
    promPoints(`max_over_time(wireguard_connected_peers[1d])`, DAYS * 24 * 60, 86400),
    webAppHosts(),
  ])

  return {
    version,
    gap: await versionGap('wg-easy/wg-easy', version),
    counts,
    peers,
    daily: peak.map((p) => ({ date: localDay(p.t * 1000), peers: p.v })),
    url: hosts["wg-easy"] === undefined ? null : `https://${hosts["wg-easy"]}`,
  }
}

/**
 * Every peer, whether or not it has ever connected.
 *
 * Keyed off the byte counters rather than the handshake series, because a
 * peer that has never completed a handshake has no handshake sample at all —
 * and a configured-but-never-used peer is exactly the one worth seeing.
 */
async function loadWgPeers(): Promise<Peer[]> {
  const [handshake, rx, tx] = await Promise.all([
    promVector('wireguard_latest_handshake_seconds'),
    promVector('wireguard_received_bytes'),
    promVector('wireguard_sent_bytes'),
  ])

  const num = (v: VectorLike[], name: string): number =>
    Number(v.find((r) => r.metric.name === name)?.value[1] ?? 0)

  const shake = new Map(handshake.map((r) => [r.metric.name ?? '?', Number(r.value[1])]))

  return rx
    .map((r) => {
      const name = r.metric.name ?? '?'
      // The exporter reports 0 for "never", which as an age would render as
      // "just now" — the exact opposite of what it means.
      const seconds = shake.get(name) ?? 0
      const ago = seconds > 0 ? Date.now() / 1000 - seconds : null
      return {
        name,
        ipv4: r.metric.ipv4Address ?? null,
        enabled: r.metric.enabled !== 'false',
        handshakeAgo: ago,
        ago: ago === null ? 'never' : since(ago),
        rx: Number(r.value[1]),
        tx: num(tx, name),
      }
    })
    .sort((a, b) => (a.handshakeAgo ?? Infinity) - (b.handshakeAgo ?? Infinity))
}

type VectorLike = { metric: Record<string, string>; value: [number, string] }

// ── Egress: the ways out ───────────────────────────────────────────────────

/**
 * One entry per gluetun instance, from `fleet.vpnEgress`.
 *
 * The list is nix's, deliberately: a third tunnel registers itself from the
 * `mkGluetunInstance` call that creates it, so this page grows without being
 * told. Everything time-varying is fetched per instance and in parallel —
 * where it comes out now, how reliable it has been, and which containers are
 * currently sharing its namespace.
 */
async function loadOutbound(ctx: { hc: string }): Promise<OutboundData> {
  let declared: Declared[] = []
  try {
    declared = JSON.parse(process.env.VPN_EGRESS ?? '[]') as Declared[]
  } catch {
    declared = []
  }

  if (declared.length === 0) {
    return {
      tunnels: [],
      gluetun: EMPTY_COMMITS,
      exporter: EMPTY_GAP,
      note:
        'No VPN egress declared. The list comes from fleet.vpnEgress, which ' +
        'mkGluetunInstance fills in — see platform/gluetun-lib.nix.',
    }
  }

  const liveness = await promVector('container_up')
  const upOf = (name: string): boolean | null => {
    const hit = liveness.find((r) => r.metric.name === name)
    return hit === undefined ? null : hit.value[1] === '1'
  }

  const [tunnels, gluetun, exporter] = await Promise.all([
    Promise.all(declared.map((d) => loadTunnel(d, ctx.hc, upOf))),
    // Read from the first instance's banner, and correct for all of them:
    // `mkGluetunInstance` pins one image digest, so a second tunnel is the
    // same binary. See `OutboundData.gluetun`.
    gluetunBuild(declared[0]?.container ?? ''),
    // No running version to compare against, deliberately unfaked: the image
    // is a digest-pinned `:latest` and the exporter prints no version in its
    // log, serves none on /metrics, and has no endpoint that would say. So
    // this lists what EXISTS and the panel says it cannot tell you which of it
    // is running — which is the true statement, and still tells you a release
    // came out.
    versionGap('thecfu/gluetun-exporter', null, { notesWhenUnknown: true }),
  ])

  return { tunnels, gluetun, exporter, note: null }
}

/** The commit gluetun states in its startup banner, and master since it. */
async function gluetunBuild(container: string): Promise<CommitGap> {
  if (container === '') return EMPTY_COMMITS
  const banner = await lokiLatest(`{container=${JSON.stringify(container)}} |= "Running version"`)
  // `Running version latest built on 2026-07-29T…Z (commit b00279b) on Linux …`
  const commit = /\(commit ([0-9a-f]{7,40})\)/.exec(banner ?? '')?.[1] ?? null
  return commitsSince('qdm12/gluetun', commit)
}

type Declared = {
  container: string
  exporter: string
  job: string
  controlPort: number
  subject: string
  provider: string
  keyExpiry: string
  runbook: string
  portForwarding: boolean
  tenants: string[]
}

async function loadTunnel(
  d: Declared,
  hc: string,
  upOf: (name: string) => boolean | null,
): Promise<Tunnel> {
  const control = `${hc}:${String(d.controlPort)}`
  const job = JSON.stringify(d.job)

  const [ip, port, up, uptime7d, daily] = await Promise.all([
    // The provider's own view of where this tunnel surfaces. Nothing on this
    // box can answer it — the container sees a tun0 with a private address,
    // and the exit address is only knowable from outside.
    getJson<{
      public_ip?: string
      country?: string
      city?: string
      region?: string
      organization?: string
      timezone?: string
    }>(`${control}/v1/publicip/ip`),
    d.portForwarding ? getJson<{ port?: number }>(`${control}/v1/portforward`) : null,
    promScalar(`gluetun_vpn_status{job=${job}}`),
    promScalar(`avg_over_time(gluetun_vpn_status{job=${job}}[7d])`),
    promPoints(`avg_over_time(gluetun_vpn_status{job=${job}}[1d])`, DAYS * 24 * 60, 86400),
  ])

  const expiry = Date.parse(`${d.keyExpiry}T00:00:00Z`)

  return {
    key: d.container,
    subject: d.subject,
    provider: d.provider,
    container: d.container,
    exporter: d.exporter,
    runbook: d.runbook,
    portForwarding: d.portForwarding,
    up: up === null ? null : up === 1,
    keyExpiry: d.keyExpiry,
    expiryDays: Math.round((expiry - Date.now()) / 86400_000),
    exit: {
      ip: ip?.public_ip ?? null,
      country: ip?.country ?? null,
      city: ip?.city ?? null,
      region: ip?.region ?? null,
      // "AS9009 M247 Europe SRL" — the provider's carrier, which is what an
      // observer on the far side actually sees this traffic as.
      org: ip?.organization ?? null,
      timezone: ip?.timezone ?? null,
    },
    // A forwarded port of 0 is gluetun for "none yet", not port zero.
    port: port?.port !== undefined && port.port > 0 ? port.port : null,
    uptime7d,
    daily: daily.map((p) => ({ date: localDay(p.t * 1000), uptime: p.v })),
    // The exporter is in the list because it genuinely rides the tunnel, and
    // dropping it would misreport what a tunnel outage takes down.
    tenants: d.tenants.map((name) => ({ name, up: upOf(name) })),
  }
}

/** `YYYY-MM-DD` in the box's timezone, so a column is the day you lived. */
const localDay = (ms: number): string => new Date(ms).toLocaleDateString('en-CA')

// ── Gateway: the proxy and the gate ────────────────────────────────────────

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

type TraefikData = {
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
  /** Every certificate in the store, with days left. */
  certs: { cn: string; sans: string[]; days: number }[]
  /** Share of requests per negotiated TLS version, since traefik started. */
  tls: { version: string; share: number }[]
}

/** One OIDC client, and whether anybody has actually used it. */
type IdpClient = {
  id: string
  name: string
  /** Where it lives, parsed from its launch or callback URLs. */
  host: string | null
  /** Authorizations in the window. */
  used: number
  /** Already rendered — see `TraefikData.upSeconds` for why, not how. */
  lastAgo: string | null
  /** Restricted to named groups, rather than open to every account. */
  restricted: boolean
  /**
   * Which consumer this registration is FOR, when the hostname has more
   * than one and the answer disambiguates them. Null otherwise.
   *
   * An app can legitimately need two: the proxy gate authenticates with one
   * (callback `https://<host>/oidc/callback`, generated by the publish layer
   * from `webApps.auth = "oidc"`) and the app's own login round-trips through
   * its own paths. They cannot be merged — the derived one would overwrite
   * the hand-written callbacks on every rebuild — so a pair here is a design,
   * not a leftover. This page called it a "duplicate" and invented a rename
   * to explain it, which was wrong on both counts.
   *
   * Labelled only for a shared hostname: on the other thirty-one it is noise,
   * because there is nothing to tell apart.
   */
  role: 'gate' | 'app' | null
  /** Another registration answers for the same hostname. */
  sharesHost: boolean
  /**
   * The individual authorizations behind `used`, newest first.
   *
   * Carried but not shown until a row is opened. The list of every sign-in on
   * the box is a log, and a log is what Grafana and Pocket ID's own audit page
   * are for — but "who opened THIS one, from what" is a question you ask about
   * a row you are already looking at, and paying a page load to answer it
   * elsewhere is worse than carrying eight rows that are already in memory.
   */
  opens: { id: string; ago: string; username: string; device: string; first: boolean }[]
}

type IdpUser = {
  username: string
  displayName: string
  admin: boolean
  disabled: boolean
  /**
   * The principal behind STATIC_API_KEY, not a person.
   *
   * Pocket ID materialises the static API key as a real admin account, so it
   * appears in the user list and would otherwise make a one-person box read
   * as two. Worth showing rather than filtering — it IS an admin account, and
   * one nobody would think to look for — but not worth counting as somebody.
   */
  service: boolean
  groups: string[]
  signIns: number
  lastSignInAgo: string | null
}

type IdpData = {
  version: string | null
  gap: VersionGap
  clients: IdpClient[]
  users: IdpUser[]
  groups: { name: string; members: number }[]
  /**
   * What holds a key to this house, newest first.
   *
   * The raw sign-in stream used to be here and it was the wrong thing: ten
   * rows of "signed in · santito · Chrome · 24h ago" is a log, and Grafana and
   * Pocket ID's own audit page already are one. Per DEVICE is the reading this
   * page can add — a passkey is registered to a device, so this is the list of
   * things that can authenticate as somebody, which is short, changes rarely,
   * and is worth noticing when it grows.
   */
  devices: { name: string; signIns: number; lastAgo: string }[]
  /** Authorizations per day, oldest first. */
  daily: { date: string; authorizations: number }[]
  window: {
    days: number
    signIns: number
    authorizations: number
    firstTime: number
    /** People, so not the static-API-key principal. */
    people: number
  }
  /** Whether anyone can create an account. Read back, not restated. */
  signups: string | null
  /** The audit log went back further than the pages we were willing to read. */
  truncated: boolean
}

type GatewayData = { traefik: TraefikData; idp: IdpData }

/**
 * The proxy and the gate, which only make sense together.
 *
 * traefik decides where a request goes; Pocket ID decides whether it goes at
 * all. Neither one can answer "what on this box can be reached, and by whom" —
 * the routing table knows every published name and nothing about identity, and
 * the IdP knows every identity and nothing about the forty-odd names that
 * never ask it anything. Joined here, they answer it in one table.
 *
 * The client list is fetched ONCE and handed to both halves: it is what tells
 * the routing table that an unmiddlewared router is an app doing its own OIDC
 * rather than an open door, and it is the subject of the IdP's own panel.
 */
async function loadGateway(ctx: { base: (app: string) => string }): Promise<GatewayData> {
  const idpBase = ctx.base('pocket-id')
  // Started, not awaited — see loadInbound. Both halves want it and it is one
  // request; awaiting it here would put it in front of everything else.
  const clients = idpClients(idpBase)
  const [traefik, idp] = await Promise.all([loadTraefik(clients), loadIdp(idpBase, clients)])
  return { traefik, idp }
}

type PocketClient = {
  id?: string
  name?: string
  launchURL?: string
  callbackURLs?: string[]
  isGroupRestricted?: boolean
}

async function idpClients(base: string): Promise<PocketClient[]> {
  const body = await getJson<{ data?: PocketClient[] }>(
    // 100 against a box that has 33: one page, and a second page would be a
    // second round trip to discover there was nothing on it.
    `${base}/api/oidc/clients?pagination[limit]=100`,
    { headers: { 'X-API-KEY': key('POCKETID_KEY') } },
  )
  return body?.data ?? []
}

/**
 * Is this the registration the traefik forward-auth middleware signs in with.
 *
 * Matched on the callback, because that is the one thing the generator fixes:
 * `platform`'s publish layer emits exactly `https://<host>/oidc/callback` for
 * every `webApps.auth = "oidc"` entry, and an app's own login never uses that
 * path — it round-trips through whatever its framework mounts. Pocket ID's API
 * exposes no flag for this, so the URL is the tell.
 */
function forwardAuthClient(c: PocketClient, host: string): boolean {
  const urls = c.callbackURLs ?? []
  return urls.length === 1 && urls[0] === `https://${host}/oidc/callback`
}

/** The hostname a client is for, from whichever URL it published. */
function clientHost(c: PocketClient): string | null {
  const url = c.launchURL ?? c.callbackURLs?.[0] ?? ''
  try {
    return new URL(url).hostname
  } catch {
    // A native app's callback is a custom scheme (`app.immich:///oauth-callback`)
    // with no hostname at all. Not a fault — it just cannot name a route.
    return null
  }
}

type TraefikRouter = {
  name?: string
  rule?: string
  status?: string
  provider?: string
  entryPoints?: string[]
  middlewares?: string[]
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

  const [version, overview, routers, clients, live, byEntrypoint, byService, byCode, daily, p95, certs, tls, reload] =
    await Promise.all([
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
      promPoints(
        'sum(increase(traefik_entrypoint_requests_total[1d]))',
        DAYS * 24 * 60,
        86400,
      ),
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

  const nativeHosts = new Set(
    clients.map(clientHost).filter((h): h is string => h !== null),
  )

  const version3 = version?.Version ?? null
  const http = overview?.http ?? {}
  const errors = ['routers', 'services', 'middlewares'].reduce(
    (n, k) => n + (http[k]?.errors ?? 0),
    0,
  )
  const tlsTotal = tls.reduce((n, t) => n + t.value, 0)

  return {
    version: version3,
    codename: version?.Codename ?? null,
    gap: await versionGap('traefik/traefik', version3),
    upSeconds:
      version?.startDate === undefined ? null : (
        (Date.now() - Date.parse(version.startDate)) / 1000
      ),
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
    routes: buildRoutes(routers ?? [], perRouter, nativeHosts),
    windowDays: DAYS,
    certs: certs
      .map((c) => ({
        cn: c.metric.cn ?? '?',
        // The SANs are the whole point of the wildcard: `*.toscanini.me`
        // covering every name on the box is why there is one certificate here
        // and not forty.
        sans: (c.metric.sans ?? '').split(',').filter((s) => s !== ''),
        days: (Number(c.value[1]) * 1000 - Date.now()) / 86400_000,
      }))
      .filter((c) => Number.isFinite(c.days))
      .sort((a, b) => a.days - b.days),
    tls:
      tlsTotal === 0 ?
        []
      : tls.map((t) => ({ version: t.label, share: (t.value / tlsTotal) * 100 })),
  }
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
 * is `app` — deliberately not called "open", because Jellyfin and Plane have
 * their own logins and this page has no way to know that. What it CAN say is
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

// ── Gateway: who gets in ───────────────────────────────────────────────────

type AuditEvent = {
  id?: string
  createdAt?: string
  event?: string
  username?: string
  device?: string
  city?: string
  country?: string
  data?: { clientName?: string }
}

/**
 * The audit log, back as far as the window.
 *
 * Paged because Pocket ID caps a page at a hundred and this box logs a couple
 * of hundred a fortnight. Bounded at six pages rather than "until the window
 * is covered": an instance that suddenly logs thousands a day should slow this
 * page down by nothing, and a truncated count that says so is better than a
 * complete one that arrives late.
 */
async function auditLog(base: string, sinceMs: number): Promise<{ events: AuditEvent[]; truncated: boolean }> {
  const h = { headers: { 'X-API-KEY': key('POCKETID_KEY') } }
  const events: AuditEvent[] = []

  for (let page = 1; page <= 6; page++) {
    const body = await getJson<{ data?: AuditEvent[]; pagination?: { totalPages?: number } }>(
      `${base}/api/audit-logs/all?pagination[limit]=100&pagination[page]=${String(page)}` +
        `&sort[column]=createdAt&sort[direction]=desc`,
      h,
    )
    const rows = body?.data ?? []
    events.push(...rows)
    if (rows.length === 0) return { events, truncated: false }
    if (page >= (body?.pagination?.totalPages ?? page)) return { events, truncated: false }
    // The page we just read reaches past the window, so nothing older matters.
    const oldest = Date.parse(rows[rows.length - 1]?.createdAt ?? '')
    if (Number.isFinite(oldest) && oldest < sinceMs) return { events, truncated: false }
  }
  return { events, truncated: true }
}

/**
 * Pocket ID: every account, every registered application, and who used what.
 *
 * The audit log is the whole panel, and it is the only place on this box that
 * records a sign-in at all — traefik's access log sees a 302 to the IdP and a
 * 200 afterwards, and cannot tell which human that was. Everything else here
 * (clients, users, groups) is configuration, and it is worth showing next to
 * the log for one reason: the difference between the two. A registered client
 * nobody has ever authorised is a redirect URI still trusted for an app that
 * may not exist.
 */
async function loadIdp(base: string, clientsP: Promise<PocketClient[]>): Promise<IdpData> {
  const h = { headers: { 'X-API-KEY': key('POCKETID_KEY') } }
  const windowStart = Date.now() - DAYS * 86400_000
  const version = process.env.POCKET_ID_VERSION || null

  const [clients, users, groups, log, config, gap] = await Promise.all([
    clientsP,
    getJson<{ data?: PocketUser[] }>(`${base}/api/users?pagination[limit]=100`, h),
    getJson<{ data?: { name?: string; friendlyName?: string; userCount?: number }[] }>(
      `${base}/api/user-groups?pagination[limit]=100`,
      h,
    ),
    auditLog(base, windowStart),
    getJson<{ key?: string; value?: string }[]>(`${base}/api/application-configuration`, h),
    versionGap('pocket-id/pocket-id', version),
  ])

  const recent = log.events
    .map((e) => ({ ...e, at: Date.parse(e.createdAt ?? '') }))
    .filter((e) => Number.isFinite(e.at) && e.at >= windowStart)

  const AUTHORIZED = new Set(['CLIENT_AUTHORIZATION', 'NEW_CLIENT_AUTHORIZATION'])
  const SIGNED_IN = new Set(['SIGN_IN', 'TOKEN_SIGN_IN'])

  // Keyed by client NAME, because the name is all the audit log records. A
  // client that was renamed therefore reads as unused, which is the honest
  // answer — its old authorizations belong to a name that no longer exists.
  //
  // `opens` keeps the individual events too, capped: they are the drill-down
  // behind a row, and the eighth one has stopped answering "who has been in
  // here lately" and started being a log.
  const used = new Map<string, { n: number; last: number; opens: IdpClient['opens'] }>()
  for (const e of recent) {
    const name = e.data?.clientName
    if (name === undefined || !AUTHORIZED.has(e.event ?? '')) continue
    const hit = used.get(name) ?? { n: 0, last: 0, opens: [] }
    if (hit.opens.length < 8) {
      hit.opens.push({
        id: e.id ?? `${name}-${String(e.at)}`,
        ago: since((Date.now() - e.at) / 1000),
        username: e.username ?? '?',
        device: (e.device ?? '').trim() || 'unknown device',
        first: e.event === 'NEW_CLIENT_AUTHORIZATION',
      })
    }
    used.set(name, { n: hit.n + 1, last: Math.max(hit.last, e.at), opens: hit.opens })
  }

  // What can authenticate as somebody. A passkey belongs to a device, so the
  // device string IS the credential — grouped rather than listed, because the
  // list is a log and the group is an inventory.
  const devices = new Map<string, { n: number; last: number }>()
  for (const e of recent) {
    if (!SIGNED_IN.has(e.event ?? '')) continue
    const name = (e.device ?? '').trim() || 'unknown device'
    const hit = devices.get(name) ?? { n: 0, last: 0 }
    devices.set(name, { n: hit.n + 1, last: Math.max(hit.last, e.at) })
  }

  const byHost = new Map<string, number>()
  for (const c of clients) {
    const host = clientHost(c)
    if (host !== null) byHost.set(host, (byHost.get(host) ?? 0) + 1)
  }

  const signIns = new Map<string, { n: number; last: number }>()
  for (const e of recent) {
    if (!SIGNED_IN.has(e.event ?? '')) continue
    const who = e.username ?? ''
    const hit = signIns.get(who) ?? { n: 0, last: 0 }
    signIns.set(who, { n: hit.n + 1, last: Math.max(hit.last, e.at) })
  }

  const byDay = new Map<string, number>()
  for (let i = DAYS - 1; i >= 0; i--) byDay.set(localDay(Date.now() - i * 86400_000), 0)
  for (const e of recent) {
    if (!AUTHORIZED.has(e.event ?? '')) continue
    const day = localDay(e.at)
    if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + 1)
  }

  // Pocket ID gives the static-API-key principal the all-zero UUID, which is
  // the only thing distinguishing it from a person — its username is generated
  // and its display name is whatever the release happened to call it.
  const people = (users?.data ?? []).filter(
    (u) => u.id !== '00000000-0000-0000-0000-000000000000',
  )

  return {
    version,
    gap,
    // Ordered by RECENCY, not by volume. The question a registration list
    // answers is "is this still a thing" — the live ones surface, the stale
    // ones sink, and the never-opened land at the bottom where they read as
    // the tail of one list rather than as a sentence somewhere else. Volume
    // is on the row; it is not what the order is for.
    clients: clients
      .map((c) => {
        const name = c.name ?? '?'
        const hit = used.get(name)
        const host = clientHost(c)
        return {
          id: c.id ?? name,
          name,
          host,
          used: hit?.n ?? 0,
          lastAgo: hit === undefined ? null : since((Date.now() - hit.last) / 1000),
          restricted: c.isGroupRestricted === true,
          sharesHost: host !== null && (byHost.get(host) ?? 0) > 1,
          role:
            host === null || (byHost.get(host) ?? 0) < 2 ? null
            : forwardAuthClient(c, host) ? ('gate' as const)
            : ('app' as const),
          opens: hit?.opens ?? [],
          sortAt: hit?.last ?? 0,
        }
      })
      .sort((a, b) => b.sortAt - a.sortAt || a.name.localeCompare(b.name))
      .map(({ sortAt: _sortAt, ...c }) => c),
    users: (users?.data ?? [])
      .map((u) => {
        const hit = signIns.get(u.username ?? '')
        return {
          username: u.username ?? '?',
          displayName: u.displayName ?? u.username ?? '?',
          admin: u.isAdmin === true,
          disabled: u.disabled === true,
          service: u.id === '00000000-0000-0000-0000-000000000000',
          groups: (u.userGroups ?? []).map((g) => g.friendlyName ?? g.name ?? '?'),
          signIns: hit?.n ?? 0,
          lastSignInAgo: hit === undefined ? null : since((Date.now() - hit.last) / 1000),
          // Sort key only. Kept off the type so nothing renders it and
          // reintroduces the clock the strings above exist to avoid.
          sortAt: hit?.last ?? 0,
        }
      })
      .sort((a, b) => b.sortAt - a.sortAt)
      .map(({ sortAt: _sortAt, ...u }) => u),
    groups: (groups?.data ?? []).map((g) => ({
      name: g.friendlyName ?? g.name ?? '?',
      members: g.userCount ?? 0,
    })),
    devices: [...devices]
      .map(([name, d]) => ({
        name,
        signIns: d.n,
        lastAgo: since((Date.now() - d.last) / 1000),
        sortAt: d.last,
      }))
      .sort((a, b) => b.sortAt - a.sortAt)
      .map(({ sortAt: _sortAt, ...d }) => d),
    daily: [...byDay].map(([date, authorizations]) => ({ date, authorizations })),
    window: {
      days: DAYS,
      signIns: recent.filter((e) => SIGNED_IN.has(e.event ?? '')).length,
      authorizations: recent.filter((e) => AUTHORIZED.has(e.event ?? '')).length,
      firstTime: recent.filter((e) => e.event === 'NEW_CLIENT_AUTHORIZATION').length,
      people: people.length,
    },
    signups: (config ?? []).find((c) => c.key === 'allowUserSignups')?.value ?? null,
    truncated: log.truncated,
  }
}

type PocketUser = {
  id?: string
  username?: string
  displayName?: string
  isAdmin?: boolean
  disabled?: boolean
  userGroups?: { name?: string; friendlyName?: string }[]
}

// ── Coming in: the Cloudflare tunnel ───────────────────────────────────────

/**
 * The tunnel, from both ends of it.
 *
 * Cloudflare's API knows what the EDGE sees — is the tunnel healthy, how many
 * of its four connections are up, which datacentres they landed in, and the
 * address they arrived from, which is the only place this house's WAN IP is
 * readable at all. cloudflared's own metrics know what the LOCAL end sees —
 * how many requests it forwarded, how many failed, and the QUIC round trip to
 * the edge. Neither can answer the other's half.
 */
async function loadCfTunnel(cfP: Promise<CfTunnel | undefined>): Promise<TunnelData> {
  const account = process.env.CF_ACCOUNT_ID ?? ''
  const id = process.env.CF_TUNNEL_ID ?? ''
  const auth = { headers: { Authorization: `Bearer ${key('CF_API_TOKEN')}` } }

  const [cf, config, rph, errors, inFlight, rtt, daily] = await Promise.all([
    cfP,
    // The ingress rules, which are the literal answer to "what can be reached
    // from outside" — generated from every webApp with `exposeRemotely`, so
    // this is a readback of that decision rather than a restatement of it.
    getJson<{ result?: { config?: { ingress?: { hostname?: string; service?: string }[] } } }>(
      `https://api.cloudflare.com/client/v4/accounts/${account}/cfd_tunnel/${id}/configurations`,
      auth,
    ),
    // Per HOUR over six, not per minute over ten: off-LAN traffic to this box
    // is a couple of dozen requests a day, and a per-minute rate of that is
    // indistinguishable from a tunnel carrying nothing at all.
    promScalar('sum(rate(cloudflared_tunnel_total_requests[6h])) * 3600'),
    promScalar('sum(cloudflared_tunnel_request_errors)'),
    promScalar('sum(cloudflared_tunnel_concurrent_requests_per_tunnel)'),
    // Smoothed rather than latest: the latest sample is one packet and swings
    // by tens of milliseconds; smoothed is what the connection actually feels
    // like. Averaged across the four connections, which land in two colos.
    promScalar('avg(quic_client_smoothed_rtt)'),
    promPoints('sum(increase(cloudflared_tunnel_total_requests[1d]))', DAYS * 24 * 60, 86400),
  ])

  const summary = summariseTunnel(cf, rph)
  const version = summary.clientVersion

  return {
    version,
    // cloudflared tags releases by date — `2026.7.3` — so the default
    // three-number pattern matches without help.
    gap: await versionGap('cloudflare/cloudflared', version),
    status: summary.status,
    connections: summary.connections,
    originIp: summary.originIp,
    edges: summary.edges,
    heldForSeconds: summary.heldForSeconds,
    // Already milliseconds — quic-go reports these in ms, and the readings
    // (3-8, to a Buenos Aires edge from Buenos Aires) are only sane on that
    // reading. Dividing by anything produced 5 nanoseconds.
    rttMs: rtt,
    requestsPerHour: rph,
    errors,
    inFlight,
    daily: daily.map((p) => ({ date: localDay(p.t * 1000), requests: p.v })),
    published: (config?.result?.config?.ingress ?? [])
      // The last rule is the catch-all, which has no hostname and is not a
      // published name — dropping it is what makes this list a list of names.
      .filter((r) => r.hostname !== undefined && r.hostname !== '')
      .map((r) => ({ hostname: r.hostname ?? '', service: r.service ?? '' }))
      .sort((a, b) => a.hostname.localeCompare(b.hostname)),
  }
}

// ── Coming in: the address itself ──────────────────────────────────────────

/** Public DNS, asked over HTTPS so the LAN resolver cannot answer for it. */
async function resolvePublic(name: string): Promise<{ ip: string | null; ttl: number | null }> {
  if (name === '') return { ip: null, ttl: null }
  // 1.1.1.1 directly, NOT this box's resolver: pi-hole short-circuits
  // *.toscanini.me to 192.168.0.2 so the LAN never leaves the house for its
  // own services, which is right and would make this check answer itself.
  const body = await getJson<{ Answer?: { type: number; data: string; TTL: number }[] }>(
    `https://1.1.1.1/dns-query?name=${encodeURIComponent(name)}&type=A`,
    { headers: { Accept: 'application/dns-json' } },
  )
  const a = (body?.Answer ?? []).find((r) => r.type === 1)
  return { ip: a?.data ?? null, ttl: a?.TTL ?? null }
}

async function loadDdns(cfP: Promise<CfTunnel | undefined>): Promise<DdnsData> {
  const host = process.env.DDNS_HOST ?? ''
  const version = process.env.DDCLIENT_VERSION || null
  const interval = /^(\d+)s?$/.exec(process.env.DDNS_INTERVAL ?? '')?.[1]

  let needs: DdnsData['needs'] = []
  try {
    needs = JSON.parse(process.env.DIRECT_INGRESS ?? '[]') as DdnsData['needs']
  } catch {
    needs = []
  }

  // The one ddclient failure that matters and is invisible: it cannot work out
  // the address, so it publishes nothing, so a real IP change would go
  // unnoticed. The unit still exits 0, which is why counting the log line is
  // the only way to see it.
  const FAIL = '{unit="ddclient.service"} |= "unable to determine IP address"'
  const [cf, resolved, day, week, month, gap, changes, runs] = await Promise.all([
    cfP,
    resolvePublic(host),
    lokiScalar(`sum(count_over_time(${FAIL} [24h]))`),
    lokiScalar(`sum(count_over_time(${FAIL} [7d]))`),
    lokiScalar(`sum(count_over_time(${FAIL} [30d]))`),
    versionGap('ddclient/ddclient', version),
    // `SUCCESS: [cloudflare][s2.toscanini.me]> IPv4 address set to 1.2.3.4`,
    // logged only when the record actually changes.
    lokiEntries('{unit="ddclient.service"} |= "IPv4 address set to"'),
    // systemd's own line, not ddclient's: a run that changed nothing says
    // nothing, so the service's log cannot answer "did it run". Two hours is
    // ample at a five-minute cadence and keeps the query cheap.
    lokiEntries('{unit="init.scope"} |= "Finished Dynamic DNS Client"', 120, 1),
  ])

  const seconds = interval === undefined ? null : Number(interval)
  const lastRunAt = runs[0]?.at ?? null

  const history = changes
    .map((e) => ({ at: e.at, ip: /set to ([0-9.]+)/.exec(e.line)?.[1] ?? '' }))
    .filter((h) => h.ip !== '')
    .map((h, i, all) => ({
      ...h,
      // How long the PREVIOUS address lasted, measured to this change. The
      // newest row has no successor, so its span is still running and is left
      // null rather than dated to now — "held 2 days so far" is a different
      // claim from "held 2 days".
      heldDays: i === 0 ? null : Math.round(((all[i - 1]?.at ?? h.at) - h.at) / 86400_000),
    }))

  return {
    version,
    gap,
    host,
    intervalSeconds: seconds,
    resolved: resolved.ip,
    ttl: resolved.ttl,
    actual: cf?.connections?.[0]?.origin_ip ?? null,
    lastRunAt,
    // Derived rather than asked: the timer lives in systemd and this container
    // cannot see it. `OnUnitActiveSec` restarts the clock when the last run
    // finished, so last + interval IS the next elapse — give or take the
    // seconds the run itself took.
    nextRunAt: lastRunAt === null || seconds === null ? null : lastRunAt + seconds * 1000,
    history,
    lookupFailures: { day, week, month },
    // Nothing in fleet.monitoredJobs names it, and the unit exits 0 on the
    // failure above anyway — so an OnFailure hook would not have fired either.
    monitored: false,
    needs: needs.sort((a, b) => a.port - b.port),
  }
}
