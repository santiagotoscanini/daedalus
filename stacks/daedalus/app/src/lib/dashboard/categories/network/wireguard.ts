import { publishingFacts } from '../../../contract/domains/publishing'
import { localDay, since } from '../../../format'
import { getJson } from '../../../http'
import { key } from '../../../keys'
import { lokiEntries, lokiScalar } from '../../../loki'
import { webAppHosts } from '../../../nix-manifest'
import { promPoints, promScalar, promScalars, promVector } from '../../../prom'
import { type VersionGap, versionGap } from '../../github'
import { type CfTunnel, DAYS } from './shared'

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

export type InboundData = { wireguard: WireguardData; tunnel: TunnelData; ddns: DdnsData }

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
export async function loadInbound(ctx: { hc: string }): Promise<InboundData> {
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
      configured: 'wireguard_configured_peers',
      enabled: 'wireguard_enabled_peers',
      connected: 'wireguard_connected_peers',
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
    url: hosts['wg-easy'] === undefined ? null : `https://${hosts['wg-easy']}`,
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

  const needs = (await publishingFacts()).directIngress

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
