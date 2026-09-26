// The zone half of Network › DNS, as pure functions over Cloudflare's records.
//
// Everything here is a rule applied to a list — which records point home,
// which are mail, which are debris — so it is kept apart from the fetches
// (modules/network/data/dns-zone.ts) and can be read, and tested, without a
// token or a network.

/** One record in the zone, as Cloudflare holds it. */
export type ZoneRecord = {
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
export type NameRow = {
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
export type MailDomain = {
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

export type CfRecord = {
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
export const MANAGED = 'Managed by fleet.cloudflareRoutes'

/** The zone's records, sorted into the groups the Zone view draws. */
export type ZoneGroups = {
  /** Names the zone points at the tunnel. */
  tunnel: Set<string>
  /** Names the zone points at the WAN address (the A records). */
  wan: Set<string>
  names: NameRow[]
  mail: MailDomain[]
  elsewhere: ZoneRecord[]
  leftovers: ZoneRecord[]
  unclassified: ZoneRecord[]
}

/**
 * Every record into exactly one group: pointing home, mail, elsewhere,
 * leftovers — and whatever no rule claimed, so it is shown rather than lost.
 * `lan` is pi-hole's hosts set, which decides a home name's `atHome`.
 */
export function classifyRecords(records: ZoneRecord[], lan: ReadonlySet<string>): ZoneGroups {
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
      atHome: lan.has(r.fqdn),
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

  return { tunnel, wan, names, mail, elsewhere, leftovers, unclassified }
}

/** Where the zone, pi-hole and traefik disagree about a name. */
export type ZoneDrift = {
  publishedWithoutLan: string[]
  lanWithoutRoute: string[]
  tunnelWithoutApp: string[]
}

/**
 * The three joins between the zone, pi-hole's hosts file, the webApps
 * registry and traefik's routers. `served` is null when traefik did not
 * answer; `box` is this machine's LAN address.
 */
export function zoneDrift(input: {
  published: ReadonlySet<string>
  lan: readonly { host: string; ip: string }[]
  lanSet: ReadonlySet<string>
  served: ReadonlySet<string> | null
  tunnel: ReadonlySet<string>
  box: string
}): ZoneDrift {
  const { published, lan, lanSet, served, tunnel, box } = input
  return {
    // A name traefik serves that pi-hole does not short-circuit: it still
    // works at home, by going out to Cloudflare and back in through the
    // tunnel — or not at all, if it is LAN-only.
    publishedWithoutLan: [...published].filter((h) => !lanSet.has(h)).sort(),
    // The reverse: pi-hole points a name at THIS BOX and traefik has no
    // router for it, so every request for it lands on the default
    // certificate and 404s.
    //
    // Two filters, both of which this check got wrong on the way here.
    // Traefik rather than the webApps registry, because not everything
    // traefik serves is a webApp — the shared postgres cluster is a TCP/SNI
    // router contributed as raw YAML, and comparing against webApps alone
    // reported it as broken while it was working exactly as designed. And
    // only entries whose address IS this box: a record naming a machine points
    // at another machine, so traefik is not in its path and "no router" would be
    // a true statement about an irrelevant program.
    lanWithoutRoute:
      served === null
        ? []
        : lan
            .filter((h) => h.ip === box && !served.has(h.host))
            .map((h) => h.host)
            .sort(),
    // A tunnel CNAME with no webApp behind it. The reconciler sweeps records
    // carrying its own comment, so anything here was made by hand.
    tunnelWithoutApp: [...tunnel].filter((h) => !published.has(h)).sort(),
  }
}

/** The six most recently edited records, their targets made readable. */
export function recentlyChanged(records: ZoneRecord[]): ZoneRecord[] {
  return [...records]
    .filter((r) => r.changedAgo !== null)
    .sort((a, b) => (a.changedAgo ?? 0) - (b.changedAgo ?? 0))
    .slice(0, 6)
    .map((r) => ({ ...r, content: readableTarget(r.content) }))
}

/** A record's identity. Name alone is not one — the apex holds four TXTs. */
const recordKey = (r: ZoneRecord): string => `${r.fqdn}|${r.type}|${r.content}`

const byShort = (a: ZoneRecord, b: ZoneRecord): number => a.short.localeCompare(b.short)

export const age = (iso: string | undefined): number | null => {
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
export function readableTarget(content: string): string {
  return content.endsWith('.cfargotunnel.com') ? 'the tunnel' : content
}

export const toRecord =
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
export function isDebris(r: ZoneRecord, all: ZoneRecord[]): boolean {
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
export function mailPosture(domain: string, records: ZoneRecord[]): MailDomain {
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
