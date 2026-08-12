import { readFile } from 'node:fs/promises'
import { type NetworkFacts, networkFacts } from '../../../contract/domains/network'
import { getJson } from '../../../http'
import { PIHOLE, piholeAdmin, piholeSid } from './shared'

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

/**
 * The other half of what this resolver does.
 *
 * pi-hole is the DHCP server as well, so the addresses on the LAN are decided
 * here rather than by the router — and the fixed ones are declared in the repo, not
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
  /**
   * False when the hostsfile could not be read — an empty list then means
   * "couldn't ask", not "none declared", and the page says so instead of
   * quietly rendering zero reservations.
   */
  reservationsKnown: boolean
  /** Offers, acks and declines since FTL started — see `loadResolver`. */
  counters: {
    offers: number | null
    acks: number | null
    declines: number | null
    nak: number | null
  }
}

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
export type DhcpData = {
  dhcp: Dhcp
  devices: Device[]
  /** The service behind both halves — see `piholeAdmin`. */
  version: string | null
  admin: string | null
}

/**
 * The reservation lines, from the same encrypted hostsfile pi-hole's dnsmasq
 * reads — the host renders a copy at DHCP_HOSTS_PATH (see daedalus.nix). Not
 * part of the network export domain, because nix cannot read a sops file at
 * eval and the household inventory has no place in the (public) repo.
 *
 * Null when the file cannot be read: the mount or render broke, which is a
 * different fact from "no reservations declared".
 */
async function loadReservationLines(): Promise<string[] | null> {
  try {
    const raw = await readFile(process.env.DHCP_HOSTS_PATH ?? '/dhcp/hosts', 'utf8')
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'))
  } catch {
    return null
  }
}

export async function loadDhcp(): Promise<DhcpData> {
  const base = PIHOLE()
  const [sid, admin] = await Promise.all([piholeSid(base), piholeAdmin()])
  const metrics = await getJson<{
    metrics?: { dhcp?: { offer?: number; ack?: number; decline?: number; nak?: number } }
  }>(`${base}/api/info/metrics`, sid === null ? {} : { headers: { sid } })

  const dhcp = dhcpConfig(
    (await networkFacts()).dhcp,
    await loadReservationLines(),
    metrics?.metrics?.dhcp,
  )
  return {
    dhcp,
    devices: await loadDevices(dhcp.reservations),
    version: process.env.PIHOLE_VERSION || null,
    admin,
  }
}

/**
 * The DHCP half: how it is configured, and what it has actually done.
 *
 * The configuration is bound in rather than asked of FTL, because the
 * reservations are DECLARED — a list read back from the running service would
 * be the same nine lines with no way to tell a declared one from something
 * somebody clicked in. The pool comes from the network export domain; the
 * reservations come from the rendered hostsfile (the declared source, just
 * decrypted); the counters come from FTL because only it knows them.
 */
function dhcpConfig(
  cfg: NetworkFacts['dhcp'],
  hostLines: string[] | null,
  counters: { offer?: number; ack?: number; decline?: number; nak?: number } | undefined,
): Dhcp {
  return {
    active: cfg.active,
    router: cfg.router,
    start: cfg.start,
    end: cfg.end,
    leaseTime: cfg.leaseTime,
    reservationsKnown: hostLines !== null,
    reservations: (hostLines ?? [])
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
