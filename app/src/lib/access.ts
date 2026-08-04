import { WINDOW_SPEC, type AccessWindow } from './access-window'

// Who is reaching an app from the internet.
//
// Source is traefik's JSON access log in Loki, filtered to the `cfweb`
// entrypoint — the Cloudflare tunnel. That restriction is not a simplification,
// it is the only thing that can be answered:
//
//   Remote requests arrive through cloudflared, which forwards the edge's
//   Cf-Connecting-Ip and Cf-Ipcountry headers. traefik is configured to keep
//   exactly those two plus User-Agent and X-Forwarded-For
//   (stacks/traefik/traefik.nix) and drop every other header, so this is the
//   only source of client geography anywhere on this box.
//
//   LAN requests have no client identity at all. A rootless container's
//   published port goes through rootlessport, which rewrites the source address
//   to a podman bridge address — every phone, laptop and WireGuard peer in the
//   house shows up as 10.89.x.x. There is nothing to count.
//
// So an app that is not `stage = "live"` has no access patterns to show, and
// the tab says that rather than rendering four zeroes.
//
// These are the same queries the "Public edge" and "Geography" rows of the
// s2-security Grafana dashboard run, with `RequestHost` pinned to one app
// instead of grouped over all of them.

const LOKI = () => process.env.LOKI_URL ?? 'http://loki:3100'

type VectorResult = { metric: Record<string, string>; value: [number, string] }

export type CountRow = { key: string; count: number }
export type CountryRow = { code: string; name: string; flag: string; count: number }
export type ClientRow = { ip: string; code: string; flag: string; count: number }
export type PathRow = { path: string; status: string; count: number }
export type RejectRow = {
  ts: string
  status: string
  method: string
  path: string
  ip: string
  code: string
  flag: string
  agent: string
}

export type AppAccess = {
  /** False when Loki could not be reached; distinct from "no traffic". */
  available: boolean
  window: AccessWindow
  total: number
  rejected: number
  clients: number
  countries: number
  /** Requests per bucket across the window, for a sparkline. */
  series: number[]
  byCountry: CountryRow[]
  byClient: ClientRow[]
  byPath: PathRow[]
  byAgent: CountRow[]
  recentRejects: RejectRow[]
}

export function noAccess(window: AccessWindow): AppAccess {
  return {
    available: false,
    window,
    total: 0,
    rejected: 0,
    clients: 0,
    countries: 0,
    series: [],
    byCountry: [],
    byClient: [],
    byPath: [],
    byAgent: [],
    recentRejects: [],
  }
}

/**
 * @param hostname the app's published hostname — `RequestHost` in the access
 *        log, which is what makes this per-app rather than global.
 */
export async function appAccess(hostname: string, window: AccessWindow): Promise<AppAccess> {
  const spec = WINDOW_SPEC[window]
  const host = safeHost(hostname)
  const range = window

  // `entryPointName = cfweb` on top of the `|= cfweb` line filter: the line
  // filter is the cheap index-level prefilter, the label matcher is the one
  // that is actually exact.
  const base =
    '{container="traefik"} |= `cfweb` | json ' +
    `| entryPointName = \`cfweb\` | RequestHost = \`${host}\``

  const [total, rejected, clients, countries, byCountry, byClient, byPath, byAgent, series, rejects] =
    await Promise.allSettled([
      instant(`sum(count_over_time(${base} [${range}]))`),
      instant(`sum(count_over_time(${base} | DownstreamStatus =~ \`[45]..\` [${range}]))`),
      instant(
        `count(sum by (request_Cf_Connecting_Ip) (count_over_time(${base} | request_Cf_Connecting_Ip != \`\` [${range}])))`,
      ),
      instant(
        `count(sum by (request_Cf_Ipcountry) (count_over_time(${base} | request_Cf_Ipcountry != \`\` [${range}])))`,
      ),
      instant(
        `topk(25, sum by (request_Cf_Ipcountry) (count_over_time(${base} | request_Cf_Ipcountry != \`\` [${range}])))`,
      ),
      instant(
        `topk(15, sum by (request_Cf_Connecting_Ip, request_Cf_Ipcountry) (count_over_time(${base} | request_Cf_Connecting_Ip != \`\` [${range}])))`,
      ),
      instant(`topk(15, sum by (RequestPath, DownstreamStatus) (count_over_time(${base} [${range}])))`),
      instant(
        `topk(10, sum by (request_User_Agent) (count_over_time(${base} | request_User_Agent != \`\` [${range}])))`,
      ),
      buckets(`sum(count_over_time(${base} [${String(spec.stepSeconds)}s]))`, spec),
      lines(`${base} | DownstreamStatus =~ \`[45]..\``, spec, 25),
    ])

  // A single failed sub-query costs its panel, not the tab. The four stats and
  // six tables are independent questions and there is no reason a Loki hiccup
  // on one should blank the others.
  const num = (r: PromiseSettledResult<VectorResult[]>): number =>
    r.status === 'fulfilled' && r.value[0] ? Number(r.value[0].value[1]) : 0

  const rows = (r: PromiseSettledResult<VectorResult[]>): VectorResult[] =>
    r.status === 'fulfilled' ? r.value : []

  const desc = <T extends { count: number }>(xs: T[]): T[] => xs.sort((a, b) => b.count - a.count)

  return {
    // "Available" means Loki answered the question that has to work for any of
    // the rest to mean anything.
    available: total.status === 'fulfilled',
    window,
    total: num(total),
    rejected: num(rejected),
    clients: num(clients),
    countries: num(countries),
    series: series.status === 'fulfilled' ? series.value : [],
    byCountry: desc(
      rows(byCountry).map((r) => {
        const code = r.metric.request_Cf_Ipcountry ?? '??'
        return { code, name: countryName(code), flag: flagOf(code), count: Number(r.value[1]) }
      }),
    ),
    byClient: desc(
      rows(byClient).map((r) => {
        const code = r.metric.request_Cf_Ipcountry ?? ''
        return {
          ip: r.metric.request_Cf_Connecting_Ip ?? '—',
          code,
          flag: flagOf(code),
          count: Number(r.value[1]),
        }
      }),
    ),
    byPath: desc(
      rows(byPath).map((r) => ({
        path: r.metric.RequestPath ?? '/',
        status: r.metric.DownstreamStatus ?? '',
        count: Number(r.value[1]),
      })),
    ),
    byAgent: desc(
      rows(byAgent).map((r) => ({ key: r.metric.request_User_Agent ?? '', count: Number(r.value[1]) })),
    ),
    recentRejects: rejects.status === 'fulfilled' ? rejects.value : [],
  }
}

// Generous, and measured rather than guessed. Loki here is a single binary
// over 30 days of traefik access log, and it does not answer a batch faster
// than it answers the slowest member: eight concurrent instant queries all
// return together, at 0.6s for a 24h window, 3.2s for 7d and 8.4s for 30d. Add
// the two range queries and the 30-day view lands near eleven seconds. A 10s
// timeout turned that into "Loki did not answer", which was a lie about a
// working query.
const QUERY_TIMEOUT_MS = 25_000

async function instant(query: string): Promise<VectorResult[]> {
  const url = `${LOKI()}/loki/api/v1/query?query=${encodeURIComponent(query)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`loki HTTP ${String(res.status)}`)
  const body = (await res.json()) as { data?: { result?: VectorResult[] } }
  return body.data?.result ?? []
}

/** One number per bucket across the window — a histogram, not a rolling rate. */
async function buckets(
  query: string,
  spec: { seconds: number; stepSeconds: number },
): Promise<number[]> {
  const end = Math.floor(Date.now() / 1000)
  const start = end - spec.seconds
  const url =
    `${LOKI()}/loki/api/v1/query_range?query=${encodeURIComponent(query)}` +
    `&start=${String(start)}&end=${String(end)}&step=${String(spec.stepSeconds)}`
  const res = await fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`loki HTTP ${String(res.status)}`)
  const body = (await res.json()) as {
    data?: { result?: { values: [number, string][] }[] }
  }
  return (body.data?.result?.[0]?.values ?? []).map(([, v]) => Number(v))
}

/**
 * Recent rejected requests, parsed out of the raw log line.
 *
 * Parsed here rather than pulled apart with more LogQL because at this point
 * the JSON line is already in hand and every extra `sum by` is another query.
 * Note the raw keys are hyphenated (`request_Cf-Connecting-Ip`) — the
 * underscored spelling used in the queries above is LogQL's own rewrite of
 * them into label names, and only exists inside a query.
 */
async function lines(
  selector: string,
  spec: { seconds: number },
  limit: number,
): Promise<RejectRow[]> {
  const end = Date.now() * 1e6
  const start = (Date.now() - spec.seconds * 1000) * 1e6
  const url =
    `${LOKI()}/loki/api/v1/query_range?query=${encodeURIComponent(selector)}` +
    `&start=${String(start)}&end=${String(end)}&limit=${String(limit)}&direction=backward`

  const res = await fetch(url, { signal: AbortSignal.timeout(QUERY_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`loki HTTP ${String(res.status)}`)
  const body = (await res.json()) as {
    data?: { result?: { values: [string, string][] }[] }
  }

  const out: RejectRow[] = []
  for (const stream of body.data?.result ?? []) {
    for (const [ns, line] of stream.values) {
      let e: Record<string, unknown>
      try {
        e = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const code = str(e['request_Cf-Ipcountry'])
      out.push({
        ts: new Date(Number(BigInt(ns) / 1_000_000n)).toISOString(),
        status: str(e.DownstreamStatus),
        method: str(e.RequestMethod),
        path: str(e.RequestPath) || '/',
        ip: str(e['request_Cf-Connecting-Ip']) || '—',
        code,
        flag: flagOf(code),
        agent: str(e['request_User-Agent']),
      })
    }
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, limit)
}

function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v)
}

/**
 * Country names resolved server-side, so the page ships text rather than
 * depending on whichever ICU data the visitor's browser happens to carry.
 */
function countryName(code: string): string {
  // Cloudflare's two pseudo-codes. `XX` is "the edge could not geolocate this
  // client", `T1` is a Tor exit node — neither is an ISO region and
  // Intl.DisplayNames would hand back the code unchanged with no explanation.
  if (code === 'XX') return 'Unknown'
  if (code === 'T1') return 'Tor exit node'
  try {
    return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' }).of(code) ?? code
  } catch {
    return code
  }
}

/** Regional-indicator pair. Only for real ISO codes — 🇽🇽 renders as tofu. */
function flagOf(code: string): string {
  if (!/^[A-Z]{2}$/.test(code) || code === 'XX' || code === 'T1') return ''
  return String.fromCodePoint(
    ...[...code].map((c) => 0x1f1e6 + (c.codePointAt(0) ?? 65) - 65),
  )
}

/**
 * The hostname lands inside a LogQL backtick string. It comes from the registry
 * and is already constrained to one label under the base domain, but this is a
 * query interpolation and interpolations get escaped, not trusted.
 */
function safeHost(hostname: string): string {
  return hostname.replace(/[^a-z0-9.-]/gi, '')
}
