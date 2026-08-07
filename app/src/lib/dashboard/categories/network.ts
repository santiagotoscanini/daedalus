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
  getText,
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
import { clientHost, idpClients, type PocketClient } from '../idp'
import { lanHosts, webAppHosts } from '../../nix-manifest'
import { BASE_DOMAIN } from '../../hostname'
import { key, localDay, since } from '../format'

export type NetworkTab = 'general' | 'wireguard' | 'proxy' | 'outbound' | 'dns' | 'dhcp'

export type NetworkData =
  | ({ tab: 'general' } & GeneralData)
  | ({ tab: 'wireguard' } & InboundData)
  | ({ tab: 'proxy' } & TraefikData)
  | ({ tab: 'outbound' } & OutboundData)
  | ({ tab: 'dns' } & DnsData)
  | ({ tab: 'dhcp' } & DhcpData)

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

/**
 * The house network — a different subject from every tab beside it, which are
 * each one piece of software. This one is the wire.
 *
 * It keeps apart two readings of "the connection" that get used
 * interchangeably and are not the same measurement. The NIC counters say what
 * crossed the cable: a film streamed from Jellyfin to the TV is most of a
 * gigabyte of that and never touches the internet. The hourly speed test says
 * what the ISP line can carry. One is usage and the other is capacity, and
 * neither bounds the other — the wire routinely carries more than the line
 * could, because most of it never leaves the house.
 */
type GeneralData = {
  /** Everything crossing the network cable, internal traffic included. */
  wire: {
    inMbps: number | null
    outMbps: number | null
    /** 24 hours at 5-minute resolution. */
    inHistory: number[]
    outHistory: number[]
    inDay: number | null
    outDay: number | null
    /** What the NIC negotiated with the switch, in Mbps. */
    linkMbps: number | null
  }
  /** The ISP line, as the hourly speed test last found it. */
  line: {
    down: number | null
    up: number | null
    ping: number | null
    /** Where MySpeed itself is published, read from the manifest. */
    url: string | null
    /** 7 days of the hourly test. */
    downHistory: number[]
    upHistory: number[]
    pingHistory: number[]
  }
  /**
   * The uplink, one hop at a time.
   *
   * Two probes rather than one because together they localise a fault that
   * either alone only reports: gateway up with the internet down is the ISP,
   * both down is this box's own link.
   */
  hops: Hop[]
  router: {
    gateway: string
    lan: string
    /** This house's public address — see the note on the fetch. */
    wan: string | null
    /** Where a person goes to configure it — HTTPS; see the note in nix. */
    adminUrl: string
    /** What the router says it is. Null when it did not answer. */
    model: string | null
    hardware: string | null
    firmware: string | null
    /** ISO date the firmware was built. */
    built: string | null
    /** The product name, which the device never states. Declared in nix. */
    product: string
  }
  proxy: { rpm: number | null; routers: number | null; spark: number[] }
  /** Bytes per container over 24h, biggest mover first. */
  services: { name: string; in: number; out: number }[]
  dns: {
    queries: number | null
    /** Queries whose client was 127.0.0.1 — every container on the box. */
    fromBox: number | null
    topDomains: { label: string; value: number }[]
  }
}

type Hop = {
  id: string
  label: string
  up: boolean | null
  rttMs: number | null
  history: number[]
}

/**
 * One thing on the LAN.
 *
 * Two sources merged on the hardware address, because between them they answer
 * a question neither does alone. pi-hole's network table knows everything that
 * has ever asked for a name — including machines with static addresses that
 * never took a lease. Nix knows the nine addresses this house FIXES. A device
 * in the first and not the second got whatever was free; one in the second and
 * not the first is declared and has not been switched on.
 */
type Device = {
  name: string | null
  ip: string
  mac: string
  queries: number
  /**
   * Ages in seconds, resolved on the server rather than timestamps resolved in
   * the browser: the page is streamed, so a clock read on the client would
   * differ from the one the server rendered and hydration would fault.
   *
   * Null for a reservation the resolver has never seen answer.
   */
  lastSeenAgo: number | null
  knownForDays: number | null
  /** Given a fixed address in nix, rather than whatever the pool had free. */
  reserved: boolean
}

export async function loadNetwork(
  tab: string,
  ctx: { base: (app: string) => string; hc: string },
): Promise<NetworkData> {
  switch (tab) {
    case 'wireguard':
      return { tab: 'wireguard', ...(await loadInbound(ctx)) }
    case 'proxy':
      return { tab: 'proxy', ...(await loadProxy(ctx)) }
    case 'outbound':
      return { tab: 'outbound', ...(await loadOutbound(ctx)) }
    case 'dns':
      return { tab: 'dns', ...(await loadDns(ctx)) }
    case 'dhcp':
      return { tab: 'dhcp', ...(await loadDhcp()) }
    default:
      return { tab: 'general', ...(await loadGeneral()) }
  }
}

/** How far back the two VPN tabs chart. A column per day, same as the AI tabs. */
const DAYS = 14

/** Everything the box has that is not the loopback — in practice, enp3s0. */
const NIC = 'node_network_%s_bytes_total{device!="lo"}'
const nic = (dir: 'receive' | 'transmit') => NIC.replace('%s', dir)

async function loadGeneral(): Promise<GeneralData> {
  const [
    speed,
    speedHistory,
    wire,
    wireHistory,
    hops,
    rpm,
    overview,
    rpmSpark,
    pihole,
    services,
    router,
    hosts,
    tunnel,
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
        // Bits, because a link is sold and negotiated in bits and the speed
        // test reports bits — the whole board would otherwise print two
        // numbers eight times apart in the same unit column.
        inMbps: `sum(rate(${nic('receive')}[5m])) * 8 / 1e6`,
        outMbps: `sum(rate(${nic('transmit')}[5m])) * 8 / 1e6`,
        inDay: `sum(increase(${nic('receive')}[24h]))`,
        outDay: `sum(increase(${nic('transmit')}[24h]))`,
        linkMbps: 'max(node_network_speed_bytes{device!="lo"}) * 8 / 1e6',
      }),
      Promise.all([
        promSeries(`sum(rate(${nic('receive')}[5m])) * 8 / 1e6`, 24 * 60, 300),
        promSeries(`sum(rate(${nic('transmit')}[5m])) * 8 / 1e6`, 24 * 60, 300),
      ]),
      loadHops(),
      promScalar('sum(rate(traefik_service_requests_total[10m])) * 60'),
      // One number wanted out of it — the router count under the headline —
      // and it is a call to a container on the next bridge over, so it costs
      // less than the prometheus query that would half-answer it.
      getJson<{ http?: { routers?: { total?: number } } }>('http://traefik:8080/api/overview'),
      promSeries('sum(rate(traefik_service_requests_total[5m])) * 60', 6 * 60, 120),
      loadAsked(),
      loadServiceTraffic(),
      loadRouter(),
      webAppHosts(),
      // Cloudflare's own view of the tunnel, for exactly one field. cloudflared
      // never learns the WAN address it is dialling out from, and neither does
      // anything else on this box behind NAT — the edge records the address the
      // connection arrived from, so this is the only vantage point on the box
      // that can answer "what is our public IP" truthfully.
      getJson<{ result?: CfTunnel }>(
        `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID ?? ''}/cfd_tunnel/${
          process.env.CF_TUNNEL_ID ?? ''
        }`,
        { headers: { Authorization: `Bearer ${key('CF_API_TOKEN')}` } },
      ),
    ])

  return {
    wire: {
      inMbps: wire.inMbps,
      outMbps: wire.outMbps,
      inHistory: wireHistory[0] ?? [],
      outHistory: wireHistory[1] ?? [],
      inDay: wire.inDay,
      outDay: wire.outDay,
      linkMbps: wire.linkMbps,
    },
    line: {
      down: speed.down,
      up: speed.up,
      ping: speed.ping,
      // From the manifest, never derived from the key: the hostname a stack
      // publishes on is a nix fact, and guessing it produces a link that 404s
      // for every app whose name and hostname differ.
      url: hosts.myspeed === undefined ? null : `https://${hosts.myspeed}`,
      downHistory: speedHistory[0] ?? [],
      upHistory: speedHistory[1] ?? [],
      pingHistory: speedHistory[2] ?? [],
    },
    hops,
    router: {
      ...router,
      gateway: process.env.GATEWAY_IP ?? DASH_IP,
      lan: LAN_IP,
      wan: tunnel?.result?.connections?.[0]?.origin_ip ?? null,
      adminUrl: process.env.ROUTER_ADMIN_URL ?? '',
    },
    proxy: { rpm, routers: overview?.http?.routers?.total ?? null, spark: rpmSpark },
    services,
    dns: pihole,
  }
}

/** Printed when nix did not bind an address, which would be a config fault. */
const DASH_IP = '—'

/**
 * What the router is, from the router.
 *
 * It serves no API — every configuration call sits behind an authenticated
 * session — but its login page carries a build stamp in a meta tag, and that
 * tag is served to anyone who asks:
 *
 *     <meta name="version" content="AXE75v1_1.10.5_2025-11-26T09:34:41.954Z">
 *
 * Model, hardware revision, firmware and the date it was built, from the
 * device itself. So the one fact on this page that would otherwise be typed
 * into nix and left to rot the next time the thing updates itself is derived
 * instead, and a firmware bump shows up here without anyone editing anything.
 *
 * Not fetched through the tunnel or a proxy — straight at the default route
 * over the LAN. A router that has stopped answering returns nulls, which the
 * board prints as such rather than as a stale reading.
 */
const ROUTER_STAMP = /name="version"\s+content="([^"_]+?)_([^"_]+)_([^"]+)"/

async function loadRouter(): Promise<{
  model: string | null
  hardware: string | null
  firmware: string | null
  built: string | null
  product: string
}> {
  const product = process.env.ROUTER_PRODUCT ?? ''
  const blank = { model: null, hardware: null, firmware: null, built: null, product }

  const url = process.env.ROUTER_URL
  if (url === undefined || url === '') return blank

  const html = await getText(`${url}/webpages/onboarding.html`)
  const m = html === null ? null : ROUTER_STAMP.exec(html)
  if (m === null) return blank

  // "AXE75v1" — the trailing vN is the hardware revision, and separating it
  // keeps the model comparable to the name on the box and on the support site.
  const rev = /^(.*?)(v\d+)$/.exec(m[1] ?? '')
  return {
    model: rev?.[1] ?? m[1] ?? null,
    hardware: rev?.[2] ?? null,
    firmware: m[2] ?? null,
    // Date only: the build's millisecond is not a fact anyone reads.
    built: (m[3] ?? '').slice(0, 10) || null,
    product,
  }
}

const HOPS = [
  { id: 'gateway', label: 'The router' },
  { id: 'internet', label: 'Past it' },
]

async function loadHops(): Promise<Hop[]> {
  const [up, rtt, history] = await Promise.all([
    promVector('network_hop_up'),
    promVector('network_hop_rtt_seconds * 1000'),
    Promise.all(
      HOPS.map((h) =>
        promSeries(`network_hop_rtt_seconds{hop="${h.id}"} * 1000`, 6 * 60, 300),
      ),
    ),
  ])

  const at = (v: typeof up, id: string) => v.find((r) => r.metric.hop === id)
  return HOPS.map((h, i) => {
    const u = at(up, h.id)
    return {
      ...h,
      up: u === undefined ? null : Number(u.value[1]) === 1,
      // Absent rather than zero when the probe timed out — the exporter emits
      // no rtt at all in that case, so there is nothing to mistake for "fast".
      rttMs: Number(at(rtt, h.id)?.value[1] ?? NaN) || null,
      history: history[i] ?? [],
    }
  })
}

/**
 * Bytes per container over a day.
 *
 * Only containers with a network namespace of their own appear, which is the
 * exporter's doing rather than a filter here: one sharing gluetun's namespace
 * has no traffic separable from the other nine, and one on the host's would
 * report the whole box. gluetun stands in for the download stack, and its
 * figure is the encrypted traffic that crossed the wire.
 */
async function loadServiceTraffic(): Promise<GeneralData['services']> {
  const [inBytes, outBytes] = await Promise.all([
    promVector('sum by (name) (increase(container_network_receive_bytes_total[24h]))'),
    promVector('sum by (name) (increase(container_network_transmit_bytes_total[24h]))'),
  ])

  const rows = new Map<string, { name: string; in: number; out: number }>()
  const add = (v: typeof inBytes, dir: 'in' | 'out') => {
    for (const r of v) {
      const name = r.metric.name
      if (name === undefined) continue
      const row = rows.get(name) ?? { name, in: 0, out: 0 }
      row[dir] = Math.max(0, Number(r.value[1]))
      rows.set(name, row)
    }
  }
  add(inBytes, 'in')
  add(outBytes, 'out')

  return [...rows.values()].filter((r) => r.in + r.out > 0).sort((a, b) => b.in + b.out - (a.in + a.out))
}

/**
 * Pi-hole off the bridge rather than on its public hostname.
 *
 * Both reads below carry identities — which names the house looked up, which
 * devices are on it, what their MAC addresses are. On the public hostname they
 * would have to be added to the unauthenticated bypass that lets this app read
 * the aggregate counts, which would put the whole list one unauthenticated GET
 * away from anything on the LAN. Dialled directly there is nothing to widen.
 */
const PIHOLE = () => process.env.PIHOLE_URL ?? 'http://host.containers.internal:8080'

/** What the house looked up, and how much of it came from this box. */
async function loadAsked(): Promise<GeneralData['dns']> {
  const base = PIHOLE()
  const sid = await piholeSid(base)
  const h = sid === null ? {} : { headers: { sid } }

  const [domains, clients] = await Promise.all([
    getJson<{ domains?: { domain?: string; count?: number }[]; total_queries?: number }>(
      `${base}/api/stats/top_domains?count=12`,
      h,
    ),
    getJson<{ clients?: { ip?: string; count?: number }[] }>(
      `${base}/api/stats/top_clients?count=20`,
      h,
    ),
  ])

  return {
    queries: domains?.total_queries ?? null,
    // Every container resolves through the host's stub, so pi-hole sees one
    // client for all of them. That number is the reason this panel cannot be
    // broken down per service, and printing it is more useful than pretending
    // the limitation is not there.
    fromBox: (clients?.clients ?? []).find((c) => c.ip === '127.0.0.1')?.count ?? null,
    topDomains: (domains?.domains ?? []).map((d) => ({
      label: d.domain ?? '?',
      value: d.count ?? 0,
    })),
  }
}

type FtlDevice = {
  hwaddr?: string
  interface?: string
  firstSeen?: number
  lastQuery?: number
  numQueries?: number
  ips?: { ip?: string; name?: string | null; lastSeen?: number }[]
}

/**
 * Everything on the LAN: what the resolver has seen, and what nix fixes.
 *
 * The observed half is the nearest thing this house has to the router's own
 * client list, and it arrives by a different route entirely — the router
 * serves no API, but everything on the network resolves through this box, so
 * FTL's network table has a row for anything that ever asked for a name. A
 * machine with a static address and no DHCP lease is in there too, which is
 * why this is not the lease list.
 *
 * The declared half is merged in on the hardware address rather than shown
 * beside it, because the two lists are the same subject: a reservation IS a
 * device, and the fact worth seeing is which devices have one. A reservation
 * whose MAC never appears is kept and marked never seen — declaring an address
 * for something that has not existed in months is exactly the drift a separate
 * panel of nine rows would never surface.
 *
 * The loopback row is dropped: it is this box talking to itself, it is the
 * single busiest "device" by two orders of magnitude, and leaving it in makes
 * every real device's share round to zero.
 */
async function loadDevices(reservations: Dhcp['reservations']): Promise<Device[]> {
  const base = PIHOLE()
  const sid = await piholeSid(base)
  const body = await getJson<{ devices?: FtlDevice[] }>(
    `${base}/api/network/devices?max_devices=200&max_addresses=4`,
    sid === null ? {} : { headers: { sid } },
  )

  const now = Date.now() / 1000
  const fixed = new Map(reservations.map((r) => [r.mac.toLowerCase(), r]))

  const seen: Device[] = (body?.devices ?? [])
    .filter((d) => d.interface !== 'lo')
    .map((d) => {
      // One row per device, not per address: a phone that held three leases
      // over a year is one thing on the network. The newest address is the
      // one it is reachable at now.
      const ips = (d.ips ?? []).filter((a) => a.ip !== undefined && !a.ip.includes(':'))
      const best = [...ips].sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))[0]
      const mac = (d.hwaddr ?? '?').toLowerCase()
      const res = fixed.get(mac)
      return {
        // The declared name wins where there is one: it is what this house
        // calls the thing, while FTL's is whatever the device announced to
        // DHCP — and half of them announce nothing at all.
        name:
          res?.name ??
          (best?.name !== undefined && best.name !== null && best.name !== '' ? best.name : null),
        ip: best?.ip ?? '?',
        mac,
        queries: d.numQueries ?? 0,
        lastSeenAgo: now - (d.lastQuery ?? 0),
        knownForDays: (now - (d.firstSeen ?? now)) / 86400,
        reserved: res !== undefined,
      }
    })

  const known = new Set(seen.map((d) => d.mac))
  const unseen: Device[] = reservations
    .filter((r) => !known.has(r.mac.toLowerCase()))
    .map((r) => ({
      name: r.name,
      ip: r.ip,
      mac: r.mac.toLowerCase(),
      queries: 0,
      lastSeenAgo: null,
      knownForDays: null,
      reserved: true,
    }))

  // Never-seen last within their section; otherwise most recent first.
  return [...seen, ...unseen].sort(
    (a, b) => (a.lastSeenAgo ?? Infinity) - (b.lastSeenAgo ?? Infinity),
  )
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
type TunnelSummary = {
  status: string | null
  connections: number | null
  /** This house's WAN address, as Cloudflare's edge sees it arriving. */
  originIp: string | null
  /** Cloudflare's own name for the version cloudflared is running. */
  clientVersion: string | null
  /** Edge datacentres the tunnel's connections landed in. */
  edges: { colo: string; count: number }[]
  /** How long the oldest connection has been up — a proxy for last reconnect. */
  heldForSeconds: number | null
  requestsPerHour: number | null
}

function summariseTunnel(t: CfTunnel | undefined, requestsPerHour: number | null): TunnelSummary {
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
async function loadProxy(ctx: { base: (app: string) => string }): Promise<TraefikData> {
  return loadTraefik(idpClients(ctx.base('pocket-id')))
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
  const routes = buildRoutes(routers ?? [], perRouter, nativeHosts)

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
      tlsTotal === 0 ?
        []
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

// ── DNS: the resolver, and the name it resolves ────────────────────────
//
// One tab for two halves of the same sentence. A name becomes an address in
// exactly two places: pi-hole, for anything asked from inside the house, and
// the toscanini.me zone at Cloudflare, for everything asked from outside it.
// Neither is legible without the other — the zone alone cannot explain why
// `jellyfin.toscanini.me` works on the sofa and not on mobile data, and the
// resolver alone cannot explain what the internet is told.
//
// The registration sits here too because it is the failure nothing on this box
// would notice: every hostname, certificate, tunnel route and OIDC redirect
// URI on the machine is a leaf of one domain name with one expiry date.

type ResolverData = {
  version: string | null
  gap: VersionGap
  /** `on` is null when FTL did not answer; `resumesIn` only when paused. */
  blocking: { on: boolean | null; resumesIn: number | null }
  /**
   * The four-way split of every query in FTL's retained window.
   *
   * Read from the upstreams endpoint rather than the metrics one, because
   * these have to add up to the same total the per-upstream counts come out
   * of: `/api/info/metrics` counts replies since the process started, which is
   * a different window and quietly disagrees.
   */
  answered: { local: number; cached: number; forwarded: number; blocked: number }
  queries: { total: number | null; perSecond: number | null; blockedPct: number | null }
  clients: { total: number | null; active: number | null }
  lists: { gravity: number | null; allowed: number | null; denied: number | null }
  cache: { size: number | null; inserted: number | null; evicted: number | null; expired: number | null }
  upstreams: Upstream[]
  types: { label: string; value: number }[]
  /** Hourly buckets over the last day, oldest first. */
  history: { label: string; total: number; blocked: number; forwarded: number }[]
  store: { queries: number | null; sinceSeconds: number | null; bytes: number | null }
}

/**
 * The other half of what this resolver does.
 *
 * pi-hole is the DHCP server as well, so the addresses on the LAN are decided
 * here rather than by the router — and the fixed ones are declared in nix, not
 * clicked into the admin. That is what makes them worth a panel: a reservation
 * is the reason something else on this box is allowed to name an address.
 */
type Dhcp = {
  active: boolean
  router: string
  /** The pool handed out to everything without a reservation. */
  start: string
  end: string
  leaseTime: string
  reservations: { mac: string; ip: string; name: string }[]
  /** Offers, acks and declines since FTL started — see `loadResolver`. */
  counters: { offers: number | null; acks: number | null; declines: number | null; nak: number | null }
}

/** One resolver every name not answered locally is forwarded to. */
type Upstream = {
  ip: string
  /** FTL's reverse lookup of it — both of these answer as `dns.google`. */
  name: string
  count: number
  /** Mean reply time. FTL reports seconds; this is milliseconds. */
  replyMs: number | null
  /**
   * Named in `services.pihole-ftl.settings.dns.upstreams`.
   *
   * FTL keeps counting a resolver it was forwarding to before a rebuild
   * changed the list, so "we sent 5,000 queries here" and "we are configured
   * to send queries here" are separate claims and the page makes both.
   */
  declared: boolean
}

/** One record in the zone, as Cloudflare holds it. */
type ZoneRecord = {
  /** The label under the base domain, or `@` for the apex. */
  short: string
  fqdn: string
  type: string
  content: string
  proxied: boolean
  /** Cloudflare's own note. `Managed by fleet.cloudflareRoutes` for ours. */
  comment: string | null
  /** Age of the last edit, in seconds. */
  changedAgo: number | null
}

/**
 * A published name, and what each side of the front door does with it.
 *
 * `atHome` is pi-hole answering from its own hosts file; `away` is what the
 * zone tells the internet. The pairing is the point — every combination of the
 * two is a different service, and three of the four are intentional.
 */
type NameRow = {
  short: string
  fqdn: string
  atHome: boolean
  away: 'tunnel' | 'wan' | null
  proxied: boolean
  /** Ours to reconcile: the record carries the route-sync comment. */
  managed: boolean
  changedAgo: number | null
}

/** How one domain is set up to send and receive mail. */
type MailDomain = {
  domain: string
  mx: string[]
  /** The `all` qualifier decides what a receiver does with a forgery. */
  spf: { include: string[]; qualifier: string | null } | null
  /** Selector count — three for Proton, one for SimpleLogin. */
  dkim: number
  dmarc: { policy: string | null } | null
  /**
   * The records the four readings above were derived FROM.
   *
   * Carried so the summary can be checked rather than trusted. A posture is an
   * interpretation, and an interpretation that hides its inputs is where a
   * page starts claiming DKIM is fine because it counted a record that turned
   * out to be something else.
   */
  records: ZoneRecord[]
}

/** The registration itself, from the registry's RDAP service. */
type Registration = {
  registrar: string | null
  registrarUrl: string | null
  /** Seconds until it lapses. Negative would mean it already has. */
  expiresIn: number | null
  expiresOn: string | null
  registeredAgo: number | null
  changedAgo: number | null
  /** EPP status codes, in words. `client transfer prohibited` is the lock. */
  status: string[]
  /** Whether the REGISTRY holds a DS record — the only side that counts. */
  signed: boolean | null
  nameservers: string[]
  note: string | null
}

type ZoneData = {
  domain: string
  registration: Registration
  cf: {
    status: string | null
    plan: string | null
    dnssec: string | null
    createdAgo: number | null
    /** Null when the zone could not be read at all. */
    records: number | null
  }
  names: NameRow[]
  elsewhere: ZoneRecord[]
  leftovers: ZoneRecord[]
  mail: MailDomain[]
  /**
   * Records that landed in none of the groups above.
   *
   * Always rendered when non-empty, and the reason it exists is that the four
   * groups are RULES — "has an MX", "is an _acme-challenge", "points at the
   * tunnel" — and a rule set that does not cover the zone should say so
   * instead of quietly showing 34 of 37 records. Empty today; a record type
   * nobody here has used yet lands in it rather than nowhere.
   */
  unclassified: ZoneRecord[]
  /** Group totals plus the zone's own count, so the arithmetic is on the page. */
  tally: { total: number | null; house: number; mail: number; elsewhere: number; leftovers: number; unclassified: number }
  changed: ZoneRecord[]
  /** Published names with no record in the zone at all — LAN-only. */
  lanOnly: number
  drift: { publishedWithoutLan: string[]; lanWithoutRoute: string[]; tunnelWithoutApp: string[] }
  note: string | null
}

/**
 * One entry in pi-hole's hosts file, with what the rest of the box says about
 * it.
 *
 * The row exists because of the join, not the entry: a name and an address is
 * pi-hole's own screen and adds nothing here. Whether traefik has a router for
 * it, and whether the same name is also published to the internet, are facts
 * from two other systems that decide what the entry actually does.
 */
type LanName = {
  short: string
  fqdn: string
  ip: string
  /** Anything but the LAN address — the gaming PC is the only one today. */
  elsewhere: boolean
  /**
   * traefik has a router, HTTP or TCP, for this name.
   *
   * Null for an entry pointing anywhere but this box, and that is not a
   * missing reading — traefik is not in the path at all, so "no router" would
   * be a true statement about an irrelevant program. It is also null when
   * traefik could not be asked, because a claim about what is NOT served must
   * not be made from an empty list.
   */
  served: boolean | null
  /** The zone publishes it too, so it works from outside the house. */
  public: boolean
}

type DnsData = { resolver: ResolverData; zone: ZoneData; lan: LanName[]; admin: string | null }

/**
 * The other half of what this box does for the LAN.
 *
 * Its own tab rather than a corner of the resolver's, because it is a
 * different service that happens to share a process: DNS answers "what
 * address is this name", DHCP decides "what address is this device". The only
 * thing they have in common is FTL, and a reader looking for a lease is not
 * looking for a zone.
 *
 * Loaded on its own rather than out of `loadResolver`, so the tab costs the
 * one metrics call it actually reads instead of the nine that page makes.
 */
type DhcpData = {
  dhcp: Dhcp
  devices: Device[]
  /** The service behind both halves — see `piholeAdmin`. */
  version: string | null
  admin: string | null
}

async function loadDhcp(): Promise<DhcpData> {
  const base = PIHOLE()
  const [sid, admin] = await Promise.all([piholeSid(base), piholeAdmin()])
  const metrics = await getJson<{
    metrics?: { dhcp?: { offer?: number; ack?: number; decline?: number; nak?: number } }
  }>(`${base}/api/info/metrics`, sid === null ? {} : { headers: { sid } })

  const dhcp = dhcpConfig(metrics?.metrics?.dhcp)
  return {
    dhcp,
    devices: await loadDevices(dhcp.reservations),
    version: process.env.PIHOLE_VERSION || null,
    admin,
  }
}

/**
 * Where pi-hole's own admin is, from the manifest.
 *
 * The hostname is a nix fact and guessing it produces a link that 404s, which
 * is exactly what the hand-written one here used to do — for a second reason
 * as well: this installation serves the interface from the site ROOT, not from
 * `/admin/`. `/admin/` answers 404 and `/settings-dhcp` answers 200, so the
 * paths below are the verified ones rather than the ones the docs describe for
 * the Docker image.
 */
async function piholeAdmin(): Promise<string | null> {
  const host = (await webAppHosts()).pihole
  return host === undefined ? null : `https://${host}`
}

async function loadDns(ctx: { base: (app: string) => string }): Promise<DnsData> {
  const [resolver, zone, hosts, served, admin] = await Promise.all([
    loadResolver(ctx.base('pihole')),
    loadZone(),
    lanHosts(),
    servedHosts(),
    piholeAdmin(),
  ])

  const published = new Set(zone.names.map((n) => n.fqdn))

  return {
    resolver,
    zone,
    admin,
    lan: hosts.map((h) => {
      const elsewhere = h.ip !== LAN_IP
      return {
        fqdn: h.host,
        short: h.host.replace(new RegExp(`\\.${BASE_DOMAIN}$`), ''),
        ip: h.ip,
        elsewhere,
        served: served === null || elsewhere ? null : served.has(h.host),
        public: published.has(h.host),
      }
    }),
  }
}

/**
 * This box, as the LAN addresses it.
 *
 * Nearly every hosts entry points here, so the address is only worth printing
 * when it does NOT — and that comparison needs something to compare against.
 * Bound from `fleet.lanIp`, the same option that generates those entries, so
 * the two cannot drift apart into a page where every row looks interesting.
 */
const LAN_IP = process.env.LAN_IP ?? ''

// ── DNS: the resolver ──────────────────────────────────────────────────

type FtlUpstream = {
  ip?: string
  name?: string
  count?: number
  statistics?: { response?: number }
}

async function loadResolver(base: string): Promise<ResolverData> {
  const version = process.env.PIHOLE_VERSION || null

  let declared: string[] = []
  try {
    declared = JSON.parse(process.env.DNS_UPSTREAMS ?? '[]') as string[]
  } catch {
    declared = []
  }

  const [gap, sources, summary, ftl, metrics, types, history, store, blocking] = await Promise.all([
    versionGap('pi-hole/FTL', version),
    getJson<{
      upstreams?: FtlUpstream[]
      total_queries?: number
      forwarded_queries?: number
    }>(`${base}/api/stats/upstreams`),
    getJson<{
      queries?: { total?: number; blocked?: number; percent_blocked?: number }
      gravity?: { domains_being_blocked?: number }
    }>(`${base}/api/stats/summary`),
    getJson<{
      ftl?: {
        clients?: { total?: number; active?: number }
        query_frequency?: number
        database?: { domains?: { allowed?: { total?: number }; denied?: { total?: number } } }
      }
    }>(`${base}/api/info/ftl`),
    getJson<{
      metrics?: {
        dns?: {
          cache?: { size?: number; inserted?: number; evicted?: number; expired?: number }
        }
      }
    }>(`${base}/api/info/metrics`),
    getJson<{ types?: Record<string, number> }>(`${base}/api/stats/query_types`),
    getJson<{
      history?: { timestamp: number; total: number; cached: number; blocked: number; forwarded: number }[]
    }>(`${base}/api/history`),
    getJson<{ size?: number; queries_disk?: number; earliest_timestamp_disk?: number }>(
      `${base}/api/info/database`,
    ),
    getJson<{ blocking?: string; timer?: number | null }>(`${base}/api/dns/blocking`),
  ])

  const rows = sources?.upstreams ?? []
  const countOf = (ip: string) => rows.find((u) => u.ip === ip)?.count ?? 0
  const total = sources?.total_queries ?? null
  const forwarded = sources?.forwarded_queries ?? 0
  const cached = countOf('cache')
  const blocked = countOf('blocklist')

  // Everything FTL answered from neither the cache, the blocklist, nor an
  // upstream: the hosts file and the DHCP lease table. It is the share that
  // makes `<app>.toscanini.me` an address without leaving the house, so it is
  // worth naming rather than folding into "cached".
  const local = total === null ? 0 : Math.max(0, total - cached - blocked - forwarded)

  const cache = metrics?.metrics?.dns?.cache

  return {
    version,
    gap,
    blocking: {
      on: blocking?.blocking === undefined ? null : blocking.blocking === 'enabled',
      resumesIn: blocking?.timer ?? null,
    },
    answered: { local, cached, forwarded, blocked },
    queries: {
      total,
      perSecond: ftl?.ftl?.query_frequency ?? null,
      blockedPct: summary?.queries?.percent_blocked ?? null,
    },
    clients: { total: ftl?.ftl?.clients?.total ?? null, active: ftl?.ftl?.clients?.active ?? null },
    lists: {
      gravity: summary?.gravity?.domains_being_blocked ?? null,
      allowed: ftl?.ftl?.database?.domains?.allowed?.total ?? null,
      denied: ftl?.ftl?.database?.domains?.denied?.total ?? null,
    },
    cache: {
      size: cache?.size ?? null,
      inserted: cache?.inserted ?? null,
      evicted: cache?.evicted ?? null,
      expired: cache?.expired ?? null,
    },
    upstreams: rows
      // `cache` and `blocklist` arrive in the same list and are not resolvers
      // — they are the two ways a query never left the box. They are already
      // the larger half of `answered` above.
      .filter((u) => u.ip !== undefined && u.ip !== 'cache' && u.ip !== 'blocklist')
      .map((u) => ({
        ip: u.ip ?? '',
        name: u.name ?? '',
        count: u.count ?? 0,
        replyMs:
          u.statistics?.response === undefined || u.statistics.response === 0 ?
            null
          : u.statistics.response * 1000,
        declared: declared.includes(u.ip ?? ''),
      }))
      .sort((a, b) => b.count - a.count),
    types: Object.entries(types?.types ?? {})
      .filter(([, v]) => v > 0)
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    history: hourly(history?.history ?? []),
    store: {
      queries: store?.queries_disk ?? null,
      sinceSeconds:
        store?.earliest_timestamp_disk === undefined ?
          null
        : Date.now() / 1000 - store.earliest_timestamp_disk,
      bytes: store?.size ?? null,
    },
  }
}

/**
 * The DHCP half: how it is configured, and what it has actually done.
 *
 * The configuration is bound in from nix rather than asked of FTL, because the
 * reservations are DECLARED — a list read back from the running service would
 * be the same nine lines with no way to tell a declared one from something
 * somebody clicked in. The counters come from FTL because only it knows them.
 */
function dhcpConfig(counters: { offer?: number; ack?: number; decline?: number; nak?: number } | undefined): Dhcp {
  let cfg: Partial<{
    active: boolean
    router: string
    start: string
    end: string
    leaseTime: string
    hosts: string[]
  }> = {}
  try {
    cfg = JSON.parse(process.env.DHCP_CONFIG ?? '{}') as typeof cfg
  } catch {
    cfg = {}
  }

  return {
    active: cfg.active === true,
    router: cfg.router ?? '',
    start: cfg.start ?? '',
    end: cfg.end ?? '',
    leaseTime: cfg.leaseTime ?? '',
    reservations: (cfg.hosts ?? [])
      .map((h) => h.split(','))
      // "MAC,IP,hostname". Anything shorter is an entry shape this page does
      // not understand, and inventing a name for it would be worse than
      // leaving it out — dnsmasq accepts several other forms.
      .filter((p) => p.length >= 3)
      .map((p) => ({ mac: (p[0] ?? '').toLowerCase(), ip: p[1] ?? '', name: p[2] ?? '' }))
      .sort((a, b) => cmpIp(a.ip, b.ip)),
    counters: {
      offers: counters?.offer ?? null,
      acks: counters?.ack ?? null,
      declines: counters?.decline ?? null,
      nak: counters?.nak ?? null,
    },
  }
}

/** Numeric by octet — a string sort puts .100 before .2, which reads as a bug. */
function cmpIp(a: string, b: string): number {
  const parts = (s: string) => s.split('.').map(Number)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 4; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * FTL's ten-minute buckets, summed into hours.
 *
 * 144 columns across a panel is a texture, not a chart — at this width each
 * one would be under two pixels. An hour is also the honest resolution for the
 * question the chart answers ("when is this house awake"), and the buckets are
 * counts, so summing them is exact rather than a resample.
 */
function hourly(
  raw: { timestamp: number; total: number; cached: number; blocked: number; forwarded: number }[],
): ResolverData['history'] {
  const by = new Map<number, { total: number; blocked: number; forwarded: number }>()
  for (const b of raw) {
    const hour = Math.floor(b.timestamp / 3600) * 3600
    const acc = by.get(hour) ?? { total: 0, blocked: 0, forwarded: 0 }
    acc.total += b.total
    acc.blocked += b.blocked
    acc.forwarded += b.forwarded
    by.set(hour, acc)
  }

  return [...by]
    .sort((a, b) => a[0] - b[0])
    // FTL's window is a rolling 24 hours, so the oldest hour is a fragment of
    // one — a stub column that reads as a quiet spell rather than as an
    // artefact of where the window happens to start. The newest is also
    // partial, and that one stays: "so far this hour" is what a live chart is
    // supposed to show.
    .slice(-24)
    .map(([hour, v]) => ({
      // Formatted on the SERVER, like every other relative time on this
      // dashboard: a Date read during render disagrees between the streamed
      // HTML and the hydrated tree and React discards the whole subtree.
      label: new Date(hour * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      ...v,
    }))
}

// ── DNS: the zone ──────────────────────────────────────────────────────

const CF_API = 'https://api.cloudflare.com/client/v4'

type CfRecord = {
  name?: string
  type?: string
  content?: string
  proxied?: boolean
  comment?: string | null
  modified_on?: string
}

/**
 * Records the cloudflared reconciler owns.
 *
 * The same string `stacks/cloudflared` stamps on everything it creates, and
 * the same string its sweep matches on when it deletes. Restated here because
 * this is the reader of a contract the writer defines; if it ever changes
 * there, this page stops claiming ours are ours, which is the safe direction.
 */
const MANAGED = 'Managed by fleet.cloudflareRoutes'

async function loadZone(): Promise<ZoneData> {
  const domain = BASE_DOMAIN
  const zoneId = process.env.CF_ZONE_ID ?? ''
  const auth = { headers: { Authorization: `Bearer ${key('CF_DNS_TOKEN')}` } }

  const [registration, zone, recordsBody, lan, published, served] = await Promise.all([
    rdap(domain),
    getJson<{ result?: { status?: string; plan?: { name?: string }; created_on?: string } }>(
      `${CF_API}/zones/${zoneId}`,
      auth,
    ),
    getJson<{ result?: CfRecord[] }>(`${CF_API}/zones/${zoneId}/dns_records?per_page=500`, auth),
    lanHosts(),
    webAppHosts(),
    servedHosts(),
  ])
  const dnssec = await getJson<{ result?: { status?: string } }>(
    `${CF_API}/zones/${zoneId}/dnssec`,
    auth,
  )

  const raw = recordsBody?.result ?? null
  const records = (raw ?? []).map(toRecord(domain))
  const lanSet = new Set(lan.map((h) => h.host))
  const publishedSet = new Set(Object.values(published))

  // Every name the zone points at this house: the tunnel CNAMEs the reconciler
  // maintains, plus the one A record ddclient keeps on the WAN address.
  const tunnel = new Set(
    records.filter((r) => r.type === 'CNAME' && r.content.endsWith('.cfargotunnel.com')).map((r) => r.fqdn),
  )
  const wan = new Set(records.filter((r) => r.type === 'A').map((r) => r.fqdn))

  const names: NameRow[] = records
    .filter((r) => tunnel.has(r.fqdn) || wan.has(r.fqdn))
    .map((r) => ({
      short: r.short,
      fqdn: r.fqdn,
      atHome: lanSet.has(r.fqdn),
      away: tunnel.has(r.fqdn) ? ('tunnel' as const) : ('wan' as const),
      proxied: r.proxied,
      managed: r.comment === MANAGED,
      changedAgo: r.changedAgo,
    }))
    .sort((a, b) => a.short.localeCompare(b.short))

  const mailNames = new Set(mailDomains(records))
  const mail = [...mailNames].sort().map((d) => mailPosture(d, records))
  const rest = records.filter((r) => !tunnel.has(r.fqdn) && !wan.has(r.fqdn) && !isMail(r, mailNames))
  const elsewhere = rest.filter((r) => !isDebris(r, records)).sort(byShort)
  const leftovers = rest.filter((r) => isDebris(r, records)).sort(byShort)

  // What the groups claimed, so whatever is left can be SHOWN rather than
  // lost. Identity is the whole triple: one name holds several records of one
  // type — the apex carries four TXTs — so keying on `fqdn` would let three of
  // them vanish into a set of one. The house group is not in here because its
  // records are the tunnel and WAN ones, already excluded below.
  const claimed = new Set(
    [...mail.flatMap((m) => m.records), ...elsewhere, ...leftovers].map(recordKey),
  )
  const unclassified = records.filter(
    (r) => !tunnel.has(r.fqdn) && !wan.has(r.fqdn) && !claimed.has(recordKey(r)),
  )

  return {
    domain,
    registration,
    cf: {
      status: zone?.result?.status ?? null,
      plan: zone?.result?.plan?.name ?? null,
      dnssec: dnssec?.result?.status ?? null,
      createdAgo: age(zone?.result?.created_on),
      records: raw === null ? null : raw.length,
    },
    names,
    elsewhere,
    leftovers,
    mail,
    unclassified,
    tally: {
      total: raw === null ? null : raw.length,
      house: names.length,
      mail: mail.reduce((n, m) => n + m.records.length, 0),
      elsewhere: elsewhere.length,
      leftovers: leftovers.length,
      unclassified: unclassified.length,
    },
    changed: [...records]
      .filter((r) => r.changedAgo !== null)
      .sort((a, b) => (a.changedAgo ?? 0) - (b.changedAgo ?? 0))
      .slice(0, 6)
      .map((r) => ({ ...r, content: readableTarget(r.content) })),
    lanOnly: [...lanSet].filter((h) => !tunnel.has(h) && !wan.has(h)).length,
    drift: {
      // A name traefik serves that pi-hole does not short-circuit: it still
      // works at home, by going out to Cloudflare and back in through the
      // tunnel — or not at all, if it is LAN-only.
      publishedWithoutLan: [...publishedSet].filter((h) => !lanSet.has(h)).sort(),
      // The reverse: pi-hole points a name at THIS BOX and traefik has no
      // router for it, so every request for it lands on the default
      // certificate and 404s.
      //
      // Two filters, both of which this check got wrong on the way here.
      // Traefik rather than the webApps registry, because not everything
      // traefik serves is a webApp — the shared postgres cluster is a TCP/SNI
      // router contributed as raw YAML, and comparing against webApps alone
      // reported it as broken while it was working exactly as designed. And
      // only entries whose address IS this box: `gaming-pc.local` points at
      // 192.168.0.120, so traefik is not in its path and "no router" would be
      // a true statement about an irrelevant program.
      lanWithoutRoute:
        served === null ? (
          []
        ) : (
          lan
            .filter((h) => h.ip === LAN_IP && !served.has(h.host))
            .map((h) => h.host)
            .sort()
        ),
      // A tunnel CNAME with no webApp behind it. The reconciler sweeps records
      // carrying its own comment, so anything here was made by hand.
      tunnelWithoutApp: [...tunnel].filter((h) => !publishedSet.has(h)).sort(),
    },
    note:
      raw !== null ? null
      : key('CF_DNS_TOKEN') === '' ?
        'No Cloudflare token in this container — see daedalus-dashboard-keys.'
      : 'Cloudflare did not answer for this zone.',
  }
}

/**
 * Every hostname traefik will answer for, HTTP and TCP.
 *
 * Both tables, because the two protocols are declared differently and a name
 * served over one is invisible in the other: `Host(...)` for HTTP routers,
 * `HostSNI(...)` for the TCP ones, which is how the shared postgres cluster is
 * published. Null when traefik did not answer — a claim about what is NOT
 * served must not be made from an empty list.
 */
async function servedHosts(): Promise<Set<string> | null> {
  const [http, tcp] = await Promise.all([
    getJson<TraefikRouter[]>('http://traefik:8080/api/http/routers'),
    getJson<TraefikRouter[]>('http://traefik:8080/api/tcp/routers'),
  ])
  if (http === null && tcp === null) return null

  const hosts = new Set<string>()
  for (const r of [...(http ?? []), ...(tcp ?? [])]) {
    for (const m of (r.rule ?? '').matchAll(/Host(?:SNI)?\(`([^`]+)`\)/g)) {
      if (m[1] !== undefined) hosts.add(m[1])
    }
  }
  return hosts
}

/** A record's identity. Name alone is not one — the apex holds four TXTs. */
const recordKey = (r: ZoneRecord): string => `${r.fqdn}|${r.type}|${r.content}`

const byShort = (a: ZoneRecord, b: ZoneRecord): number => a.short.localeCompare(b.short)

const age = (iso: string | undefined): number | null => {
  if (iso === undefined) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? (Date.now() - t) / 1000 : null
}

/**
 * What a record points at, said in a way worth reading.
 *
 * Every tunnel CNAME in this zone is the same forty-character tunnel id, and
 * printing it seven times says only that seven rows are identical — while
 * being long enough to push the name that DOES differ out of the row. The
 * substitution is safe because the id is the tunnel's: `cfargotunnel.com` is
 * not a name anything else resolves to.
 */
function readableTarget(content: string): string {
  return content.endsWith('.cfargotunnel.com') ? 'the tunnel' : content
}

const toRecord =
  (domain: string) =>
  (r: CfRecord): ZoneRecord => {
    const fqdn = r.name ?? ''
    return {
      fqdn,
      short: fqdn === domain ? '@' : fqdn.replace(new RegExp(`\\.${domain}$`), ''),
      type: r.type ?? '?',
      // TXT content arrives quoted from Cloudflare for some records and bare
      // for others — the same value, entered two different ways. Stripped so
      // the duplicate check below compares values rather than punctuation.
      content: (r.content ?? '').replace(/^"|"$/g, ''),
      proxied: r.proxied === true,
      comment: r.comment ?? null,
      changedAgo: age(r.modified_on),
    }
  }

/**
 * Records that are debris rather than configuration.
 *
 * Two rules, both computed rather than listed. An `_acme-challenge` TXT is
 * written by lego during a DNS-01 issuance and deleted by lego when it
 * finishes — one that is still here belongs to an issuance that did not clean
 * up, and it authorises nothing on its own. And an exact duplicate is a record
 * entered twice, which resolves identically and is one more thing to keep in
 * step.
 */
function isDebris(r: ZoneRecord, all: ZoneRecord[]): boolean {
  if (r.short.startsWith('_acme-challenge')) return true
  return all.filter((o) => o.fqdn === r.fqdn && o.type === r.type && o.content === r.content).length > 1
}

/** MX before the TXTs that qualify it, CNAME (the DKIM selectors) last. */
const MAIL_ORDER = ['MX', 'TXT', 'CNAME']

/** Names with an MX record — the apex and any subdomain given its own mail. */
function mailDomains(records: ZoneRecord[]): string[] {
  return [...new Set(records.filter((r) => r.type === 'MX').map((r) => r.fqdn))]
}

/**
 * Whether a record is part of a mail setup.
 *
 * Type-aware at the mail domain itself, and that is the whole subtlety: the
 * apex both receives mail and serves a website, so "every record at a name
 * with an MX" would swallow the apex CNAME and leave the zone's most visible
 * record uncategorised. MX and TXT at such a name are mail — SPF and the
 * providers' ownership tokens are the only TXT records this zone puts there —
 * and everything else is not.
 */
const isMail = (r: ZoneRecord, domains: Set<string>): boolean =>
  (domains.has(r.fqdn) && (r.type === 'MX' || r.type === 'TXT')) ||
  [...domains].some((d) => r.fqdn === `_dmarc.${d}` || r.fqdn.endsWith(`._domainkey.${d}`))

/**
 * What a receiver learns about mail claiming to be from this domain.
 *
 * The three records are one policy read in sequence — SPF says who may send,
 * DKIM signs it, DMARC says what to do when neither holds — so they are shown
 * as one row per domain rather than as eight rows of syntax. The qualifier on
 * SPF and the policy on DMARC are the two parts that decide anything.
 */
function mailPosture(domain: string, records: ZoneRecord[]): MailDomain {
  const at = (fqdn: string, type: string) => records.filter((r) => r.fqdn === fqdn && r.type === type)
  const spf = at(domain, 'TXT').find((r) => r.content.startsWith('v=spf1'))
  const dmarc = at(`_dmarc.${domain}`, 'TXT').find((r) => r.content.startsWith('v=DMARC1'))

  // Every record this domain's posture was read from, in the order the four
  // readings above use them: who receives, who may send, what signs, what a
  // receiver should do. The same set `isMail` claims, so the two cannot
  // disagree about which records belong to mail.
  const mine = records
    .filter((r) => isMail(r, new Set([domain])))
    .sort((a, b) => MAIL_ORDER.indexOf(a.type) - MAIL_ORDER.indexOf(b.type) || byShort(a, b))

  return {
    records: mine,
    domain,
    mx: at(domain, 'MX').map((r) => r.content).sort(),
    spf:
      spf === undefined ? null : (
        {
          include: [...spf.content.matchAll(/include:(\S+)/g)].map((m) => m[1] ?? ''),
          qualifier: /([-~?+])all/.exec(spf.content)?.[1] ?? null,
        }
      ),
    dkim: records.filter((r) => r.fqdn.endsWith(`._domainkey.${domain}`)).length,
    dmarc: dmarc === undefined ? null : { policy: /\bp=(\w+)/.exec(dmarc.content)?.[1] ?? null },
  }
}

// ── DNS: the registration ──────────────────────────────────────────────

/**
 * The `.me` registry's RDAP service.
 *
 * Hardcoded rather than discovered, and that is a finding rather than a
 * shortcut: IANA's bootstrap at data.iana.org/rdap/dns.json carries no service
 * entry for `me`, so rdap.org, rdap.net and rdap.iana.org all answer 404 for
 * this domain (all three checked). Identity Digital runs the registry and
 * serves it here. A second domain under a different TLD would need the
 * bootstrap file and this as its fallback.
 */
const RDAP = 'https://rdap.identitydigital.services/rdap/domain'

type RdapEntity = { roles?: string[]; vcardArray?: unknown[]; links?: { href?: string }[] }
type RdapDomain = {
  events?: { eventAction?: string; eventDate?: string }[]
  status?: string[]
  entities?: RdapEntity[]
  nameservers?: { ldhName?: string }[]
  secureDNS?: { delegationSigned?: boolean }
}

async function rdap(domain: string): Promise<Registration> {
  const empty: Registration = {
    registrar: null,
    registrarUrl: null,
    expiresIn: null,
    expiresOn: null,
    registeredAgo: null,
    changedAgo: null,
    status: [],
    signed: null,
    nameservers: [],
    note: null,
  }

  const body = await getJson<RdapDomain>(`${RDAP}/${encodeURIComponent(domain)}`, {
    headers: { Accept: 'application/rdap+json' },
  })
  if (body === null) return { ...empty, note: 'The registry’s RDAP service did not answer.' }

  const when = (action: string): string | undefined =>
    body.events?.find((e) => e.eventAction === action)?.eventDate
  const expiry = when('expiration')
  const registrar = body.entities?.find((e) => (e.roles ?? []).includes('registrar'))

  return {
    registrar: vcardName(registrar),
    // The registrar's own RDAP base doubles as the only link the registry
    // publishes for them, and it is where a renewal actually happens.
    registrarUrl: (registrar?.links ?? []).map((l) => l.href ?? '').find((h) => !h.includes('identitydigital')) ?? null,
    expiresIn: expiry === undefined ? null : (Date.parse(expiry) - Date.now()) / 1000,
    expiresOn: expiry === undefined ? null : new Date(expiry).toLocaleDateString('en-CA'),
    registeredAgo: age(when('registration')),
    changedAgo: age(when('last changed')),
    status: body.status ?? [],
    // The REGISTRY's view, which is the one that decides whether a resolver
    // validates: Cloudflare can hold signing keys all it likes, but until the
    // DS record is in the parent zone nothing checks them.
    signed: body.secureDNS?.delegationSigned ?? null,
    nameservers: (body.nameservers ?? []).map((n) => (n.ldhName ?? '').toLowerCase()).sort(),
    note: null,
  }
}

/** The `fn` entry out of an RDAP vCard — a registrar's display name. */
function vcardName(entity: RdapEntity | undefined): string | null {
  const fields = (entity?.vcardArray?.[1] ?? []) as unknown[]
  for (const f of fields) {
    if (Array.isArray(f) && f[0] === 'fn' && typeof f[3] === 'string' && f[3] !== '') return f[3]
  }
  return null
}
