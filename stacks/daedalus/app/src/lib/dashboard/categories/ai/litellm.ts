import { getJson } from '../../../http'
import { lokiLatest } from '../../../loki'
import { promBars, promScalar } from '../../../prom'
import { type CommitGap, commitsSince, type VersionGap, versionGap } from '../../github'
import { type ImageFreshness, imageFreshness } from '../../images'
import { DAYS } from './shared'

/** Requests, failures and tokens over some period. The gateway's one shape. */
type Volume = { requests: number; failed: number; tokens: number }

/**
 * One virtual key, and everything the gateway knows about what it did.
 *
 * The caller is the interesting axis on this tab and the model is not: the
 * models are all on one machine in the next room, and which checkpoint a
 * published name resolves to is a fact you configured and already know. Who is
 * hammering the gateway, how slowly it is being answered, and whether it is
 * getting answers at all — none of that is knowable from anywhere else.
 */
type Caller = Volume & {
  name: string
  /** Mean end to end for this key. Null when nothing recent to measure. */
  latencyMs: number | null
  /** Published model names this key actually reached. */
  models: string[]
  /** The last day it made a request, `YYYY-MM-DD`. */
  last: string
  /**
   * Whether a key by this name still exists on the gateway.
   *
   * The ledger is a record of what happened, and keys get rotated and deleted
   * — so a hash in it may name a credential that has since been revoked. That
   * is usually the whole explanation for a caller that starts succeeding and
   * then fails forever, and without this the row is an unanswerable hash.
   */
  live: boolean
  /** What this caller IS, for a hover. Null for an ordinary named key. */
  note: string | null
}

export type LitellmData = {
  version: string | null
  gap: VersionGap
  /** Whether the digest pin still matches the moving `main-stable` tag. */
  freshness: ImageFreshness | null
  /** Every day of the window, oldest first — including the ones with nothing. */
  daily: (Volume & { date: string })[]
  /** Null when the gateway has not served anything yet today. */
  today: Volume | null
  window: Volume & { days: number }
  /** True when the ledger had more rows than one page — see `PAGE_SIZE`. */
  partial: boolean
  inFlight: number | null
  /** Mean milliseconds the gateway itself adds on top of the model's time. */
  overheadMs: number | null
  /** What KIND of call, by endpoint — `/chat/completions` → `chat/completions`. */
  endpoints: { label: string; value: number }[]
  /** Keys that got at least one answer, busiest first. */
  callers: Caller[]
  /**
   * Keys that never got one, as a count rather than a list.
   *
   * A key that fails authentication is a hash of a credential nobody here
   * holds, so naming eleven of them individually says nothing you can act on.
   * How many, how often and how recently is the whole actionable content.
   */
  rejected: { keys: number; requests: number; last: string | null; live: number }
  /** Tools a model called back out through the gateway. */
  mcp: { server: string; tool: string; calls: number; latencyMs: number | null }[]
  /** The MCP servers those tools belong to, with their totals. */
  mcpServers: { name: string; calls: number }[]
  /** The containers standing beside the gateway — see `Neighbour`. */
  neighbours: Neighbour[]
}

/**
 * A container the gateway dials, with its own update state.
 *
 * These three have no tab of their own and no tile, which used to mean their
 * updates were invisible: three services on this box could go a year behind
 * and nothing would say so. Each is pinned like everything else here, so
 * "nothing is ever automatically up to date" (CLAUDE.md) applies to them too —
 * they just had nowhere to report it.
 *
 * `gap` and `build` are alternatives, not both: a project that cuts releases
 * gets the release list, one that ships a moving branch gets the commits since
 * its build. Which applies is a property of the upstream, not a choice.
 */
export type Neighbour = {
  container: string
  label: string
  /** What it is TO the gateway, completing "<label> — …". */
  role: string
  note: string
  repo: string
  /** What is running: a version, a short commit, or null if unknowable. */
  version: string | null
  gap: VersionGap | null
  build: CommitGap | null
}

// ── LiteLLM ────────────────────────────────────────────────────────────────

type DayMetrics = { api_requests?: number; total_tokens?: number; failed_requests?: number }
type Bucket = {
  metrics?: DayMetrics
  metadata?: { key_alias?: string | null }
  /** Only on the model-group buckets: which keys reached this model. */
  api_key_breakdown?: Record<string, Bucket>
}
type Breakdown = Record<string, Bucket> | undefined
type Day = {
  date?: string
  metrics?: DayMetrics
  breakdown?: {
    model_groups?: Record<string, Bucket>
    api_keys?: Record<string, Bucket>
    endpoints?: Record<string, Bucket>
    mcp_servers?: Record<string, Bucket>
  }
}
type DailyActivity = { results?: Day[]; metadata?: { has_more?: boolean } }

/**
 * How many ledger ROWS to ask for — not how many days.
 *
 * This is the endpoint's one real trap. `page_size` bounds the underlying
 * spend records, and there is one of those per day PER key PER model, so a day
 * with four callers costs a dozen rows. Passing `page_size = 14` for a
 * fortnight therefore returned the newest three days and reported their totals
 * as the fortnight's — a chart that silently showed a quarter of its window and
 * a "requests in 14d" figure that was out by 3x. Asking for a thousand costs
 * nothing (the response is aggregated per day before it is sent) and `partial`
 * below reports the case where even that was not enough, rather than truncating
 * quietly a second time.
 */
const PAGE_SIZE = 1000

/** The window every figure on the tab is measured over, as a PromQL range. */
const RANGE = `${String(DAYS)}d`

export async function loadLitellm(): Promise<LitellmData> {
  const auth = { headers: { Authorization: `Bearer ${process.env.LITELLM_API_KEY ?? ''}` } }

  // Every day in the window, oldest first — the chart's x axis, independent of
  // which of them the ledger happens to have a row for.
  const dates = Array.from({ length: DAYS }, (_, i) =>
    new Date(Date.now() - (DAYS - 1 - i) * 86400_000).toISOString().slice(0, 10),
  )
  const from = dates[0] ?? ''
  const today = dates[DAYS - 1] ?? ''

  const [activity, keys, version, freshness, inFlight, latSum, latCount, toolLatency, overhead] =
    await Promise.all([
      getJson<DailyActivity>(
        `http://litellm:4000/user/daily/activity?start_date=${from}&end_date=${today}` +
          `&page_size=${String(PAGE_SIZE)}`,
        auth,
      ),
      // Which keys still EXIST, as opposed to which ones have called. The ledger
      // is history and keys get rotated out of it, so the difference between the
      // two lists is what turns an unanswerable hash into "this was revoked".
      //
      // 100 is the endpoint's hard maximum, not a choice — a larger `size` is a
      // 422 rather than a clamp. `total_pages` is read below and the revoked
      // marking is dropped entirely if there is a second page, because a
      // half-read key list would mark live keys as revoked, and a wrong
      // accusation is worse here than no annotation.
      getJson<{ keys?: { token?: string }[]; total_pages?: number }>(
        'http://litellm:4000/key/list?return_full_object=true&size=100',
        auth,
      ),
      litellmVersion(auth),
      // The pin is a digest on the moving `main-stable`, so alongside "how
      // many releases behind" there is a second, sharper question only the
      // registry can answer: has the channel moved on from the pin at all.
      imageFreshness('litellm'),
      promScalar('sum(litellm_in_flight_requests)'),
      // The histogram's own sum and count, kept APART rather than divided in
      // PromQL. Two keys can share a display name — this box has two virtual keys
      // both aliased `plane` — and averaging two means is not the mean of the
      // whole; the totals have to be added before the division, which can only
      // happen after they are grouped by the name a reader sees.
      //
      // Joined on `hashed_api_key` because it is the ledger's own key, literals
      // and all (`litellm_proxy_master_key`). The `api_key_alias` label would
      // have to be matched against a name this file invents, and reports "None"
      // for exactly the keys whose names it invents.
      promBars(
        `sum by (hashed_api_key) (increase(litellm_request_total_latency_metric_sum[${RANGE}]))`,
        'hashed_api_key',
      ),
      promBars(
        `sum by (hashed_api_key) (increase(litellm_request_total_latency_metric_count[${RANGE}]))`,
        'hashed_api_key',
      ),
      // Tool calls are filed under the `model` label as `MCP: <server>-<tool>`,
      // alongside the real models — which is why every other query here joins on
      // `requested_model` instead. Here it is the label wanted.
      promBars(
        `sum by (model) (increase(litellm_request_total_latency_metric_sum[${RANGE}]))` +
          ` / sum by (model) (increase(litellm_request_total_latency_metric_count[${RANGE}]))`,
        'model',
      ),
      // What the gateway costs, separated from what the model costs. Every other
      // latency figure on this page is end-to-end and therefore mostly Lemonade;
      // this is the part that is actually attributable to litellm.
      promScalar(
        `sum(increase(litellm_overhead_latency_metric_sum[${RANGE}]))` +
          ` / sum(increase(litellm_overhead_latency_metric_count[${RANGE}]))`,
      ),
    ])

  // Order is not read off this list — the chart's axis is `dates` and
  // everything else here is a sum — so it is taken as the API sends it.
  const days = activity?.results ?? []

  // Laid over the whole window rather than taken as-is. The ledger has no row
  // at all for a day nothing was served, so using its rows directly puts two
  // non-adjacent days side by side in a chart whose whole premise is one column
  // per day — a quiet Sunday disappears and the week looks continuous.
  const byDate = new Map(days.map((d) => [d.date ?? '', volumeOf(d.metrics)]))
  const daily = dates.map((date) => ({
    date,
    ...(byDate.get(date) ?? { requests: 0, failed: 0, tokens: 0 }),
  }))
  const total = {
    ...daily.reduce(
      (a, d) => ({
        requests: a.requests + d.requests,
        failed: a.failed + d.failed,
        tokens: a.tokens + d.tokens,
      }),
      { requests: 0, failed: 0, tokens: 0 },
    ),
    days: daily.length,
  }

  const { callers, rejected } = callersOf(
    days,
    latSum,
    latCount,
    // `null` means "could not establish which keys are live" — the gateway did
    // not answer, or answered with more pages than were read. Distinct from an
    // empty set, which would claim every caller is revoked.
    keys === null || (keys.total_pages ?? 1) > 1
      ? null
      : new Set((keys.keys ?? []).map((k) => k.token ?? '')),
  )

  const toolMs = new Map(toolLatency.map((t) => [t.label, t.value * 1000]))
  const mcp = rank(
    days,
    (d) => d.breakdown?.mcp_servers,
    requestsOf,
    (k) => k,
    10,
  ).map((t) => {
    const [server, ...rest] = t.label.split('/')
    const tool = rest.join('/')
    return {
      server: server ?? '?',
      tool,
      calls: t.value,
      latencyMs: toolMs.get(`MCP: ${server ?? ''}-${tool}`) ?? null,
    }
  })

  return {
    version,
    gap: await versionGap('BerriAI/litellm', version),
    freshness,
    daily,
    today: daily.find((d) => d.date === today) ?? null,
    window: total,
    partial: activity?.metadata?.has_more === true,
    inFlight,
    overheadMs: overhead === null ? null : overhead * 1000,
    endpoints: rank(
      days,
      (d) => d.breakdown?.endpoints,
      requestsOf,
      (k) => k.replace(/^\//, ''),
    ),
    callers,
    rejected,
    mcp,
    mcpServers: [
      ...mcp.reduce(
        (m, t) => m.set(t.server, (m.get(t.server) ?? 0) + t.calls),
        new Map<string, number>(),
      ),
    ]
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls),
    neighbours: await loadNeighbours(),
  }
}

/**
 * The three containers the gateway dials, and whether each is behind.
 *
 * They had logs on this page and nothing else, which meant their UPDATES were
 * invisible — three pinned services that could drift a year behind with
 * nothing on the dashboard saying so. Every image on this box is pinned, so
 * none of them is ever automatically current; the only difference between
 * these three and the four with tabs was that the four had somewhere to say
 * it.
 *
 * Each reads its version from wherever that version actually exists, which is
 * three different places for three projects:
 *
 *   searxng            no releases, no tags, a rolling build — and it prints
 *                      `SearXNG 2026.7.30-afdfd8161` in its startup banner,
 *                      whose suffix is the commit. Read back out of Loki.
 *   mcp-grocy          cuts versioned releases and the flake pins an exact
 *                      tag, so this is the ordinary release-gap case.
 *   litellm-pgvector   no published image at all — the flake pins a source
 *                      COMMIT and builds it, so commits-since is the only
 *                      question that has an answer.
 */
async function loadNeighbours(): Promise<Neighbour[]> {
  const grocy = process.env.MCP_GROCY_VERSION || null
  const pgvectorRev = process.env.PGVECTOR_REV || null

  const [searxBanner, grocyGap, pgvectorBuild] = await Promise.all([
    lokiLatest('{container="searxng"} |~ "^SearXNG [0-9]"'),
    versionGap('miguelangel-nubla/mcp-grocy', grocy),
    commitsSince('BerriAI/litellm-pgvector', pgvectorRev, 'main'),
  ])

  // `SearXNG 2026.7.30-afdfd8161` — the date is the build, the suffix is the
  // commit it was cut from, and only the second can be compared to anything.
  const searx = /^SearXNG\s+(\S+)/.exec(searxBanner?.trim() ?? '')?.[1] ?? null
  const searxCommit = searx?.split('-')[1] ?? null

  return [
    {
      container: 'searxng',
      label: 'SearXNG',
      role: 'the web search the gateway offers',
      note: 'Registered as the `searxng` search tool, so a model asking to search the web is asking this. It answers on the shared websearch bridge and never talks to a caller directly.',
      repo: 'searxng/searxng',
      version: searx,
      gap: null,
      build: await commitsSince('searxng/searxng', searxCommit, 'master'),
    },
    {
      container: 'mcp-grocy',
      label: 'Grocy MCP',
      role: 'the local tool server it proxies',
      note: 'The one MCP server that runs on this box. TickTick is remote and logs nothing here. Every call counted in “tools models called” above passed through this container.',
      repo: 'miguelangel-nubla/mcp-grocy',
      version: grocy,
      gap: grocyGap,
      build: null,
    },
    {
      container: 'litellm-pgvector',
      label: 'pgvector connector',
      role: 'the RAG store behind /vector_store',
      note: 'Fronts pgvector in the shared pg cluster for LiteLLM’s vector-store API. Ingest failures land here rather than in the gateway’s log, which only sees the connector’s answer.',
      repo: 'BerriAI/litellm-pgvector',
      version: pgvectorRev,
      gap: null,
      build: pgvectorBuild,
    },
  ]
}

/**
 * The caller list, split at "did this key ever get an answer".
 *
 * They are not the same question and a single ranked list answers neither. By
 * tokens, a key that failed eleven times out of eleven scores zero and never
 * appears; by requests, ten such keys crowd out every caller that works. And
 * they want different treatment anyway: for a working caller you want to know
 * what it costs and how slowly it is served, and for a rejected one the only
 * facts that exist are how many attempts and how recently.
 *
 * Merged by DISPLAY NAME rather than by key hash, because two keys aliased the
 * same thing are one caller as far as anyone reading this is concerned — which
 * is also why the latency sum and count arrive separately and are divided here,
 * after the grouping.
 */
function callersOf(
  days: Day[],
  latSum: { label: string; value: number }[],
  latCount: { label: string; value: number }[],
  /** Null when the live-key list could not be established — see the caller. */
  liveKeys: Set<string> | null,
): { callers: Caller[]; rejected: LitellmData['rejected'] } {
  const sums = new Map(latSum.map((r) => [r.label, r.value]))
  const counts = new Map(latCount.map((r) => [r.label, r.value]))

  type Acc = Volume & {
    latSum: number
    latCount: number
    models: Set<string>
    last: string
    live: boolean
  }
  const byName = new Map<string, Acc>()
  const seen = new Set<string>()

  for (const d of days) {
    const date = d.date ?? ''
    for (const [hash, b] of Object.entries(d.breakdown?.api_keys ?? {})) {
      const v = volumeOf(b.metrics)
      if (v.requests === 0) continue
      const name = callerName(hash, b)
      const at = byName.get(name) ?? {
        requests: 0,
        failed: 0,
        tokens: 0,
        latSum: 0,
        latCount: 0,
        models: new Set<string>(),
        last: date,
        // The two literals are litellm's own credentials rather than rows in
        // its key table, so they are never "missing" from it — and with no
        // key list to check against, nothing is called revoked at all.
        live:
          liveKeys === null ||
          hash === 'litellm_proxy_master_key' ||
          hash === 'litellm-internal-health-check',
      }
      // One live hash is enough: a rotated key keeps its alias, so `plane`
      // legitimately covers one current key and one that was replaced.
      if (liveKeys?.has(hash) === true) at.live = true
      // Prometheus totals are per key, so they may only be added the first time
      // a hash is seen — a caller active on nine days would otherwise have its
      // latency counted nine times.
      if (!seen.has(hash)) {
        seen.add(hash)
        at.latSum += sums.get(hash) ?? 0
        at.latCount += counts.get(hash) ?? 0
      }
      at.requests += v.requests
      at.failed += v.failed
      at.tokens += v.tokens
      // The API returns newest first, so the first date a key appears on IS its
      // most recent — hence `>`, which does not depend on that staying true.
      if (date > at.last) at.last = date
      byName.set(name, at)
    }
    // Which models a key reached, from the other side of the ledger: the key
    // breakdown carries no models, but every model group carries its keys.
    for (const [group, b] of Object.entries(d.breakdown?.model_groups ?? {})) {
      for (const [hash, kb] of Object.entries(b.api_key_breakdown ?? {})) {
        byName.get(callerName(hash, kb))?.models.add(group)
      }
    }
  }

  const all = [...byName].map(([name, a]) => ({
    name,
    requests: a.requests,
    failed: a.failed,
    tokens: a.tokens,
    latencyMs: a.latCount > 0 ? (a.latSum / a.latCount) * 1000 : null,
    models: [...a.models].sort(),
    last: a.last,
    live: a.live,
    note: NOTES[name] ?? (a.live ? null : GONE),
  }))

  const dead = all.filter((c) => c.requests === c.failed)

  return {
    callers: all
      .filter((c) => c.requests > c.failed)
      .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name)),
    rejected: {
      keys: dead.length,
      requests: dead.reduce((n, c) => n + c.requests, 0),
      last: dead.reduce<string | null>((at, c) => (at === null || c.last > at ? c.last : at), null),
      // Nearly always zero, and worth stating separately when it is not: a key
      // that EXISTS and still fails every call is a different fault from one
      // that was revoked, and only the first is a problem with the gateway.
      live: dead.filter((c) => c.live).length,
    },
  }
}

const GONE =
  'No key with this hash exists on the gateway any more. It was deleted or rotated, which is usually the whole explanation for a caller that succeeded and then failed forever.'

/**
 * What litellm's own two credentials actually are.
 *
 * Both are honest entries in the caller list — they make real inference calls
 * and burn real GPU on the gaming PC — and both are unreadable without a
 * sentence. The master key in particular is not one caller: it is the admin
 * credential, and everything configured with it lands in one row.
 */
const NOTES: Record<string, string> = {
  'master key':
    'The admin credential, so this row is every consumer configured with it at once: Open WebUI (chat, RAG embeddings, transcription, speech, images), the pgvector connector, and this dashboard. Giving each its own aliased key is what would split them apart.',
  'health check':
    'LiteLLM testing its own deployments. Not a status ping: it sends a real minimal request to each one, which is why it has tokens against it. Triggered on demand, from the admin UI or /health, rather than on a schedule.',
}

function volumeOf(m: DayMetrics | undefined): Volume {
  return {
    // Every attempt, failures included — `successful_requests` is the same
    // number minus `failed_requests`, so carrying all three would be one fact
    // stated twice and a chance for them to disagree.
    requests: m?.api_requests ?? 0,
    failed: m?.failed_requests ?? 0,
    tokens: m?.total_tokens ?? 0,
  }
}

const requestsOf = (m: DayMetrics): number => m.api_requests ?? 0

/**
 * A virtual key, named.
 *
 * Most callers here carry an alias and are simply that. The rest are the two
 * keys litellm issues itself, which arrive as literal strings rather than
 * hashes and mean something specific — the master key is anything holding the
 * admin credential, the health-check key is the gateway probing its own
 * upstreams — and saying so is the difference between a caller list and a list
 * of hashes. Absent aliases arrive as null AND as the string "None", because
 * litellm stringifies its own Python None on the way out.
 */
function callerName(hash: string, b: Bucket): string {
  const alias = b.metadata?.key_alias
  if (alias !== null && alias !== undefined && alias !== '' && alias !== 'None') return alias
  if (hash === 'litellm_proxy_master_key') return 'master key'
  if (hash === 'litellm-internal-health-check') return 'health check'
  if (hash === '' || hash === 'None') return 'unattributed'
  return `key ${hash.slice(0, 8)}`
}

/**
 * LiteLLM's version, from the OpenAPI document it serves.
 *
 * There is no version endpoint and no version header — this was checked
 * against a running 1.94.0 — but the FastAPI schema carries it in `info`, and
 * the flake pins the image by digest against a moving `main-stable` tag, so
 * the tag cannot answer either.
 *
 * That document is 1.2 MB, essentially all of it endpoint schemas, and `info`
 * is the first object in it. So this reads ONE chunk off the response body and
 * hangs up: ~65 KB instead of 1.2 MB, and no JSON parse of the rest.
 */
async function litellmVersion(init: RequestInit): Promise<string | null> {
  try {
    const res = await fetch('http://litellm:4000/openapi.json', {
      ...init,
      signal: AbortSignal.timeout(4_000),
    })
    if (!res.ok || res.body === null) return null

    const reader = res.body.getReader()
    const first = await reader.read()
    await reader.cancel()
    if (first.value === undefined) return null

    const head = new TextDecoder().decode(first.value)
    return /"info"\s*:\s*\{[\s\S]*?"version"\s*:\s*"([^"]+)"/.exec(head)?.[1] ?? null
  } catch {
    return null
  }
}

/** Sum a per-day breakdown map into a ranked list, on one chosen metric. */
function rank(
  days: Day[],
  pick: (d: Day) => Breakdown,
  metric: (m: DayMetrics) => number,
  label: (k: string, b: Bucket) => string = (k) => k,
  limit = 6,
): { label: string; value: number }[] {
  const totals = new Map<string, number>()
  for (const d of days) {
    for (const [k, b] of Object.entries(pick(d) ?? {})) {
      const name = label(k, b)
      totals.set(name, (totals.get(name) ?? 0) + metric(b.metrics ?? {}))
    }
  }
  return [...totals]
    .map(([l, value]) => ({ label: l, value }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}
