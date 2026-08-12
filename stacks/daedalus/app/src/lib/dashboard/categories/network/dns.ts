import { networkFacts } from '../../../contract/domains/network'
import { BASE_DOMAIN } from '../../../hostname'
import { getJson } from '../../../http'
import { key } from '../../../keys'
import { lanHosts, webAppHosts } from '../../../nix-manifest'
import { type VersionGap, versionGap } from '../../github'
import { LAN_IP, piholeAdmin, type TraefikRouter } from './shared'

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

export async function loadDns(ctx: { base: (app: string) => string }): Promise<DnsData> {
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

// ── DNS: the resolver ──────────────────────────────────────────────────

type FtlUpstream = {
  ip?: string
  name?: string
  count?: number
  statistics?: { response?: number }
}

async function loadResolver(base: string): Promise<ResolverData> {
  const version = process.env.PIHOLE_VERSION || null

  const declared = (await networkFacts()).dnsUpstreams

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
      history?: {
        timestamp: number
        total: number
        cached: number
        blocked: number
        forwarded: number
      }[]
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
          u.statistics?.response === undefined || u.statistics.response === 0
            ? null
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
        store?.earliest_timestamp_disk === undefined
          ? null
          : Date.now() / 1000 - store.earliest_timestamp_disk,
      bytes: store?.size ?? null,
    },
  }
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

  return (
    [...by]
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
        label: new Date(hour * 1000).toLocaleTimeString('en-GB', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        ...v,
      }))
  )
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
    records
      .filter((r) => r.type === 'CNAME' && r.content.endsWith('.cfargotunnel.com'))
      .map((r) => r.fqdn),
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
  const rest = records.filter(
    (r) => !tunnel.has(r.fqdn) && !wan.has(r.fqdn) && !isMail(r, mailNames),
  )
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
        served === null
          ? []
          : lan
              .filter((h) => h.ip === LAN_IP && !served.has(h.host))
              .map((h) => h.host)
              .sort(),
      // A tunnel CNAME with no webApp behind it. The reconciler sweeps records
      // carrying its own comment, so anything here was made by hand.
      tunnelWithoutApp: [...tunnel].filter((h) => !publishedSet.has(h)).sort(),
    },
    note:
      raw !== null
        ? null
        : key('CF_DNS_TOKEN') === ''
          ? 'No Cloudflare token in this container — see daedalus-dashboard-keys.'
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
  return (
    all.filter((o) => o.fqdn === r.fqdn && o.type === r.type && o.content === r.content).length > 1
  )
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
  const at = (fqdn: string, type: string) =>
    records.filter((r) => r.fqdn === fqdn && r.type === type)
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
    mx: at(domain, 'MX')
      .map((r) => r.content)
      .sort(),
    spf:
      spf === undefined
        ? null
        : {
            include: [...spf.content.matchAll(/include:(\S+)/g)].map((m) => m[1] ?? ''),
            qualifier: /([-~?+])all/.exec(spf.content)?.[1] ?? null,
          },
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
    registrarUrl:
      (registrar?.links ?? [])
        .map((l) => l.href ?? '')
        .find((h) => !h.includes('identitydigital')) ?? null,
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
