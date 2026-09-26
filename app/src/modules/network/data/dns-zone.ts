import type { Ctx } from '../../../core/ctx'
import { lanHosts, webAppHosts } from '../../../host/nix-manifest'
import {
  age,
  type CfRecord,
  classifyRecords,
  recentlyChanged,
  toRecord,
  zoneDrift,
} from '../../../lib/dns-zone'
import { getJson } from '../../../lib/http'
import type { ZoneData } from './dns'
import { rdap } from './dns-registration'
import { lanIp, type TraefikRouter } from './shared'

// Network › DNS, the zone: the base domain as Cloudflare holds it, sorted into
// what points home, what is mail, what is elsewhere and what is debris, and
// checked against pi-hole and traefik. The fetches are here; the rules are
// pure and live in lib/dns-zone.ts.
//
// fetchZone → classifyRecords → zoneDrift → the assembly in loadZone.

const CF_API = 'https://api.cloudflare.com/client/v4'

/** Every source the zone's reading is built from, fetched at once. */
async function fetchZone(ctx: Ctx, domain: string) {
  const zoneId = ctx.env('CF_ZONE_ID') ?? ''
  const auth = { headers: { Authorization: `Bearer ${ctx.secret('CF_API_TOKEN')}` } }

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
  return { registration, zone, raw: recordsBody?.result ?? null, dnssec, lan, published, served }
}

export async function loadZone(ctx: Ctx): Promise<ZoneData> {
  const domain = ctx.site.baseDomain
  const { registration, zone, raw, dnssec, lan, published, served } = await fetchZone(ctx, domain)

  const records = (raw ?? []).map(toRecord(domain))
  const lanSet = new Set(lan.map((h) => h.host))
  const publishedSet = new Set(Object.values(published))

  const { tunnel, wan, names, mail, elsewhere, leftovers, unclassified } = classifyRecords(
    records,
    lanSet,
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
    changed: recentlyChanged(records),
    lanOnly: [...lanSet].filter((h) => !tunnel.has(h) && !wan.has(h)).length,
    drift: zoneDrift({
      published: publishedSet,
      lan,
      lanSet,
      served,
      tunnel,
      box: await lanIp(),
    }),
    note:
      raw !== null
        ? null
        : ctx.secret('CF_API_TOKEN') === ''
          ? 'No Cloudflare token in this container. See daedalus-dashboard-keys.'
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
export async function servedHosts(): Promise<Set<string> | null> {
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
