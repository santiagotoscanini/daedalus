import type { Ctx } from '../../../core/ctx'
import { lanHosts } from '../../../host/nix-manifest'
import type { VersionGap } from '../../../lib/dashboard/github'
import type { MailDomain, NameRow, ZoneRecord } from '../../../lib/dns-zone'
import { stripBaseDomain } from '../../../lib/site'
import { loadResolver } from './dns-resolver'
import { loadZone, servedHosts } from './dns-zone'
import { lanIp, piholeAdmin } from './shared'

// ── DNS: the resolver, and the name it resolves ────────────────────────
//
// One tab for two halves of the same sentence. A name becomes an address in
// exactly two places: pi-hole, for anything asked from inside the house, and
// the base domain's zone at Cloudflare, for everything asked from outside it.
// Neither is legible without the other — the zone alone cannot explain why
// `jellyfin.<baseDomain>` works on the sofa and not on mobile data, and the
// resolver alone cannot explain what the internet is told.
//
// The registration sits here too because it is the failure nothing on this box
// would notice: every hostname, certificate, tunnel route and OIDC redirect
// URI on the machine is a leaf of one domain name with one expiry date.

//
// One file per half: dns-resolver.ts (pi-hole), dns-zone.ts (Cloudflare, with
// its rules in lib/dns-zone.ts) and dns-registration.ts (RDAP). This one holds
// the tab's shapes and the join that pairs pi-hole's names with the zone's.

export type ResolverData = {
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
  cache: {
    size: number | null
    inserted: number | null
    evicted: number | null
    expired: number | null
  }
  upstreams: Upstream[]
  types: { label: string; value: number }[]
  /** Hourly buckets over the last day, oldest first. */
  history: { label: string; total: number; blocked: number; forwarded: number }[]
  store: { queries: number | null; sinceSeconds: number | null; bytes: number | null }
}

/** One resolver every name not answered locally is forwarded to. */
export type Upstream = {
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

/** The registration itself, from the registry's RDAP service. */
export type Registration = {
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

export type ZoneData = {
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
  tally: {
    total: number | null
    house: number
    mail: number
    elsewhere: number
    leftovers: number
    unclassified: number
  }
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

export type DnsData = {
  resolver: ResolverData
  zone: ZoneData
  lan: LanName[]
  admin: string | null
}

export async function loadDns(ctx: Ctx): Promise<DnsData> {
  const [resolver, zone, lanNames, served, admin] = await Promise.all([
    loadResolver(ctx, ctx.hosts.base('pihole')),
    loadZone(ctx),
    lanHosts(),
    servedHosts(),
    piholeAdmin(),
  ])

  const published = new Set(zone.names.map((n) => n.fqdn))
  const box = lanIp(ctx)

  return {
    resolver,
    zone,
    admin,
    lan: lanNames.map((h) => {
      const elsewhere = h.ip !== box
      return {
        fqdn: h.host,
        short: stripBaseDomain(ctx.site, h.host),
        ip: h.ip,
        elsewhere,
        served: served === null || elsewhere ? null : served.has(h.host),
        public: published.has(h.host),
      }
    }),
  }
}
