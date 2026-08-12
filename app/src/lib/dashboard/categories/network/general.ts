import { getJson, getText } from '../../../http'
import { key } from '../../../keys'
import { webAppHosts } from '../../../nix-manifest'
import { promScalar, promScalars, promSeries, promVector } from '../../../prom'
import { type CfTunnel, LAN_IP, PIHOLE, piholeSid } from './shared'

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
export type GeneralData = {
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

/** Everything the box has that is not the loopback — in practice, enp3s0. */
const NIC = 'node_network_%s_bytes_total{device!="lo"}'
const nic = (dir: 'receive' | 'transmit') => NIC.replace('%s', dir)

export async function loadGeneral(): Promise<GeneralData> {
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
      HOPS.map((h) => promSeries(`network_hop_rtt_seconds{hop="${h.id}"} * 1000`, 6 * 60, 300)),
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

  return [...rows.values()]
    .filter((r) => r.in + r.out > 0)
    .sort((a, b) => b.in + b.out - (a.in + a.out))
}

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
