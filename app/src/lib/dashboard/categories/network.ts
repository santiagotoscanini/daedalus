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
} from '../clients'
import {
  commitsSince,
  versionGap,
  EMPTY_COMMITS,
  EMPTY_GAP,
  type CommitGap,
  type VersionGap,
} from '../github'
import { key, since } from '../format'

export type NetworkTab = 'general' | 'wireguard' | 'outbound'

export type NetworkData =
  | ({ tab: 'general' } & GeneralData)
  | ({ tab: 'wireguard' } & WireguardData)
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
}

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
  proxy: {
    rpm: number | null
    routers: number | null
    services: number | null
    openConnections: number | null
    byService: { label: string; value: number }[]
    byCode: { label: string; value: number }[]
    spark: number[]
  }
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
  certs: { soonestDays: number | null; expiring: { name: string; days: number }[] }
}

export async function loadNetwork(
  tab: string,
  ctx: { base: (app: string) => string; hc: string },
): Promise<NetworkData> {
  switch (tab) {
    case 'wireguard':
      return { tab: 'wireguard', ...(await loadWireguard()) }
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
    proxy,
    overview,
    byService,
    byCode,
    rpmSpark,
    pihole,
    tunnel,
    wg,
    peers,
    vpnIp,
    vpnPort,
    vpnUp,
    certs,
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
    promScalars({
      rpm: 'sum(rate(traefik_service_requests_total[10m])) * 60',
      connections: 'sum(traefik_open_connections)',
    }),
    getJson<{ http?: { routers?: { total?: number }; services?: { total?: number } } }>(
      'http://traefik:8080/api/overview',
    ),
    promBars(
      'topk(8, sum by (service) (rate(traefik_service_requests_total[10m]) * 60))',
      'service',
      (s) => s.replace(/-svc@file$/, ''),
    ),
    promBars('sum by (code) (rate(traefik_service_requests_total[10m]) * 60)', 'code'),
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
    promVector('gatus_results_certificate_expiration_seconds'),
    // Per HOUR over six, not per minute over ten: off-LAN traffic to this box
    // is a couple of dozen requests a day, and a per-minute rate of that is
    // indistinguishable from a tunnel carrying nothing at all.
    promScalar('sum(rate(cloudflared_tunnel_total_requests[6h])) * 3600'),
  ])

  const expiring: { name: string; days: number }[] = certs
    .map((c) => ({ name: c.metric.name ?? '?', days: Number(c.value[1]) / 86400 }))
    .filter((c) => Number.isFinite(c.days))
    .sort((a, b) => a.days - b.days)

  return {
    wan: {
      ping: speed.ping,
      down: speed.down,
      up: speed.up,
      downHistory: speedHistory[0] ?? [],
      upHistory: speedHistory[1] ?? [],
      pingHistory: speedHistory[2] ?? [],
    },
    proxy: {
      rpm: proxy.rpm,
      routers: overview?.http?.routers?.total ?? null,
      services: overview?.http?.services?.total ?? null,
      openConnections: proxy.connections,
      byService,
      byCode,
      spark: rpmSpark,
    },
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
    certs: {
      // One number for the whole estate: a single entrypoint-level wildcard
      // covers every hostname (see CLAUDE.md), so these all move together and
      // the soonest one IS the expiry date.
      soonestDays: expiring[0]?.days ?? null,
      expiring: expiring.slice(0, 5),
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
async function loadWireguard(): Promise<WireguardData> {
  const version = process.env.WG_EASY_VERSION || null

  const [counts, peers, peak] = await Promise.all([
    promScalars({
      configured: 'wireguard_configured_peers',
      enabled: 'wireguard_enabled_peers',
      connected: 'wireguard_connected_peers',
    }),
    loadWgPeers(),
    // Peak, not average: the question a household asks of a personal VPN is
    // "did anyone use it", and a peer connected for twenty minutes averages
    // to nearly nothing over a day while being the entire answer.
    promPoints(`max_over_time(wireguard_connected_peers[1d])`, DAYS * 24 * 60, 86400),
  ])

  return {
    version,
    gap: await versionGap('wg-easy/wg-easy', version),
    counts,
    peers,
    daily: peak.map((p) => ({ date: localDay(p.t * 1000), peers: p.v })),
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
