// The AI category, one tab per service.
//
// The stack is a chain — a caller speaks the OpenAI API to LiteLLM, LiteLLM
// forwards to Lemonade on the gaming PC, Lemonade holds the weights — and the
// page used to be laid out as that chain, with a diagram across the top and
// every service's numbers crammed into a shared band underneath. That reads
// well exactly once. The questions you come back with are per-service and
// deep: which models are resident and can I free some VRAM, what is the
// gateway actually routing where, is it worth taking the update. None of those
// fit in a quarter of a shared row.
//
// So: a tab per service, and each tab is that service's page. The chain has
// not gone anywhere — it is stated in each tab's one-line lede, which is where
// a fact you already know belongs.
//
// ── who answers what ──────────────────────────────────────────────────────
//
// Worth keeping straight while reading the queries, because these are NOT
// interchangeable and picking the wrong one gives a plausible wrong number:
//
//   Lemonade  knows what is resident, what the GPU is doing, and how fast the
//             last generation ran. It does not know who asked.
//   LiteLLM   knows who asked, for what, and what it cost. It has no idea what
//             is loaded — it just forwards.
//   Prometheus holds the history of both. The lifetime counters each service
//             reports reset when its container restarts, so anything phrased
//             as "over the last N days" comes from the gateway's own ledger or
//             from a range query, never from a counter read once.

import { getJson, promBars, promScalar, promVector } from '../clients'
import { versionGap, type VersionGap } from '../github'
import { DASH, key, since } from '../format'

export type AiTab = 'lemonade' | 'litellm' | 'open-webui' | 'n8n'

export type AiData =
  | ({ tab: 'lemonade' } & LemonadeData)
  | ({ tab: 'litellm' } & LitellmData)
  | ({ tab: 'open-webui' } & OpenWebUiData)
  | ({ tab: 'n8n' } & N8nData)

/**
 * One installed model, resident or not.
 *
 * Deliberately covers the whole catalogue rather than just what is loaded:
 * the useful question here is "which of my four chat models is in the slot",
 * and that cannot be asked of a list containing only the answer.
 */
export type CatalogModel = {
  name: string
  /** In VRAM right now. At most one per type on this box — see `slots`. */
  resident: boolean
  /** Exempt from LRU eviction, and the reason a switch has to unload first. */
  pinned: boolean
  /** Most recently used of the resident set. See `last_use` in loadLemonade. */
  hot: boolean
  sizeGb: number | null
  /** llamacpp / whispercpp / sd-cpp / kokoro. */
  recipe: string
  /** rocm / vulkan / cpu — which build of that runtime is serving it. */
  backend: string | null
  device: string | null
  context: number | null
  /**
   * What this model has actually done, from Lemonade's own counters. Null for
   * a model that has not been used since the server started — which is not
   * the same as zero, and is drawn as nothing rather than as a row of noughts.
   */
  stats: {
    requests: number | null
    inputTokens: number | null
    outputTokens: number | null
    /** Last generation, not an average — Lemonade reports these as gauges. */
    tps: number | null
    ttftMs: number | null
  } | null
}

/** Every installed model of one kind, resident first. */
export type ModelCategory = {
  type: string
  /** How many of this kind may be resident at once. One, everywhere, today. */
  max: number
  models: CatalogModel[]
}

type LemonadeData = {
  version: string | null
  gap: VersionGap
  /** The server's own GUI, on the LAN. Not through traefik — it is off-box. */
  baseUrl: string
  /** The whole catalogue, grouped by kind. Ordered biggest group first. */
  categories: ModelCategory[]
  host: {
    os: string | null
    cpu: string | null
    ramGb: number | null
    gpu: string | null
    vramGb: number | null
    driver: string | null
  }
  /** The inference runtimes actually installed, with their build numbers. */
  backends: { recipe: string; backend: string; version: string; url: string | null }[]
  /** What the last generation did. A snapshot, not an average — see below. */
  last: {
    tps: number | null
    ttftMs: number | null
    requests: number | null
    inputTokens: number | null
    outputTokens: number | null
  }
  /** Live utilisation of the gaming PC. Nulls are normal — see the note. */
  live: { cpuPct: number | null; memGb: number | null; gpuPct: number | null; vramGb: number | null }
  downloads: { model: string; percent: number | null; status: string }[]
  catalog: { total: number; downloaded: number; sizeGb: number }
}

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
}

type LitellmData = {
  version: string | null
  gap: VersionGap
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
  rejected: { keys: number; requests: number; last: string | null }
  /** Tools a model called back out through the gateway. */
  mcp: { server: string; tool: string; calls: number; latencyMs: number | null }[]
  /** The MCP servers those tools belong to, with their totals. */
  mcpServers: { name: string; calls: number }[]
}

type OpenWebUiData = {
  version: string | null
  latest: string | null
  gap: VersionGap
  users: number | null
  generating: number | null
  /** Models the chat window offers, which is the gateway's list plus presets. */
  models: { id: string; name: string }[]
  /** How sign-in is configured — the answer to "why is there no login box". */
  auth: { oidc: string | null; autoRedirect: boolean; loginForm: boolean; signup: boolean }
}

type N8nData = {
  version: string | null
  gap: VersionGap
  workflows: { name: string; active: boolean }[]
  runs: {
    name: string
    status: string
    /**
     * Computed here rather than in the component on purpose: a relative time
     * derived from the client's clock renders differently on the server and on
     * hydration whenever the render straddles a boundary, which React reports
     * as a hydration mismatch.
     */
    ago: string
  }[]
  counts: { active: number | null; total: number | null; failed: number | null }
  /** Set when the API refused, which on this box means the key. */
  note: string | null
}

/** How far back the gateway charts look. Two weeks fits a column per day. */
const DAYS = 14

export async function loadAi(
  tab: string,
  ctx: { base: (app: string) => string },
): Promise<AiData> {
  switch (tab) {
    case 'litellm':
      return { tab: 'litellm', ...(await loadLitellm()) }
    case 'open-webui':
      return { tab: 'open-webui', ...(await loadOpenWebUi(ctx.base('open-webui'))) }
    case 'n8n':
      return { tab: 'n8n', ...(await loadN8n(ctx.base('n8n'))) }
    default:
      return { tab: 'lemonade', ...(await loadLemonade()) }
  }
}

// ── Lemonade ───────────────────────────────────────────────────────────────

type Health = {
  version?: string
  all_models_loaded?: {
    model_name?: string
    type?: string
    device?: string
    status?: string
    pinned?: boolean
    last_use?: number
    max_context_window?: number
    recipe?: string
    checkpoint?: string
    recipe_options?: Record<string, unknown>
  }[]
  max_models?: Record<string, number>
  pinned_models?: Record<string, number>
}

type SystemInfo = {
  'OS Version'?: string
  'Physical Memory'?: string
  Processor?: string
  devices?: {
    amd_gpu?: { available?: boolean; name?: string; vram_gb?: number; driver_version?: string }[]
  }
  recipes?: Record<
    string,
    { backends?: Record<string, { state?: string; version?: string; release_url?: string }> }
  >
}

async function loadLemonade(): Promise<LemonadeData> {
  const base = process.env.LEMONADE_URL ?? ''

  const [health, stats, info, live, downloads, catalog, perModel] = await Promise.all([
    getJson<Health>(`${base}/api/v1/health`),
    getJson<{
      tokens_per_second?: number
      time_to_first_token?: number
      request_count_total?: number
      output_tokens_total?: number
      input_tokens_total?: number
    }>(`${base}/api/v1/stats`),
    getJson<SystemInfo>(`${base}/api/v1/system-info`),
    getJson<{
      cpu_percent?: number | null
      memory_gb?: number | null
      gpu_percent?: number | null
      vram_gb?: number | null
    }>(`${base}/api/v1/system-stats`),
    getJson<{ model_name?: string; percent?: number; status?: string }[]>(
      `${base}/api/v1/downloads`,
    ),
    getJson<{
      data?: {
        id?: string
        downloaded?: boolean
        size?: number
        recipe?: string
        labels?: string[]
      }[]
    }>(`${base}/api/v1/models`),
    modelStats(),
  ])

  const version = health?.version ?? null

  const resident = [...(health?.all_models_loaded ?? [])].sort(
    (a, b) => (b.last_use ?? 0) - (a.last_use ?? 0),
  )

  const gpu = (info?.devices?.amd_gpu ?? []).find((g) => g.vram_gb !== undefined)

  const models = catalog?.data ?? []
  const loaded = new Map(resident.map((m) => [m.model_name ?? '', m]))
  const hottest = resident[0]?.model_name

  const catalogModels: CatalogModel[] = models.map((m) => {
    const id = m.id ?? '?'
    const live = loaded.get(id)
    const seen = perModel.get(id)
    return {
      name: id,
      resident: live !== undefined,
      pinned: live?.pinned === true,
      // `last_use` is a monotonic counter, not a wall clock — it orders the
      // resident set but cannot be turned into "used 4 minutes ago". Only the
      // top of that ordering is a claim worth making, so only it gets marked.
      hot: id === hottest,
      sizeGb: m.size ?? null,
      recipe: live?.recipe ?? m.recipe ?? '?',
      backend: pickBackend(live?.recipe ?? m.recipe, live?.recipe_options) ?? seen?.backend ?? null,
      device: live?.device ?? seen?.device ?? null,
      context: live?.max_context_window ?? null,
      stats: seen?.stats ?? null,
    }
  })

  // The per-type cap is what makes this page make sense: it is 1 for every
  // type here, so "which model is in the slot" is the actual question and a
  // flat list of six residents was the wrong shape for it.
  const maxes = health?.max_models ?? {}
  const typeOf = (m: (typeof models)[number]) =>
    loaded.get(m.id ?? '')?.type ?? perModel.get(m.id ?? '')?.type ?? typeFromLabels(m.labels)

  const byType = new Map<string, CatalogModel[]>()
  models.forEach((m, i) => {
    const t = typeOf(m)
    const row = catalogModels[i]
    if (row === undefined) return
    byType.set(t, [...(byType.get(t) ?? []), row])
  })

  return {
    version,
    gap: await versionGap('lemonade-sdk/lemonade', version),
    baseUrl: base,
    categories: [...byType]
      .map(([type, list]) => ({
        type,
        max: maxes[type] ?? 1,
        // Resident first, then most-used, then alphabetical — so the model in
        // the slot leads and the plausible alternatives follow it.
        models: [...list].sort(
          (a, b) =>
            Number(b.resident) - Number(a.resident) ||
            (b.stats?.requests ?? 0) - (a.stats?.requests ?? 0) ||
            a.name.localeCompare(b.name),
        ),
      }))
      // Categories with a real choice to make come first; singletons are just
      // statements of fact and can sit at the bottom.
      .sort((a, b) => b.models.length - a.models.length || a.type.localeCompare(b.type)),
    host: {
      os: info?.['OS Version'] ?? null,
      cpu: info?.Processor ?? null,
      ramGb: parseGb(info?.['Physical Memory']),
      gpu: gpu?.name ?? null,
      // 17179869183.999 GB is what this actually reports — a 16 EiB integer
      // overflow in the vendor's driver query, not a number. Anything past a
      // terabyte of VRAM is that bug, so it is dropped rather than rendered.
      vramGb: gpu?.vram_gb !== undefined && gpu.vram_gb < 1024 ? gpu.vram_gb : null,
      driver: gpu?.driver_version ?? null,
    },
    backends: Object.entries(info?.recipes ?? {}).flatMap(([recipe, r]) =>
      Object.entries(r.backends ?? {})
        .filter(([, b]) => b.state === 'installed')
        .map(([backend, b]) => ({
          recipe,
          backend,
          version: b.version ?? DASH,
          url: b.release_url ?? null,
        })),
    ),
    last: {
      tps: stats?.tokens_per_second ?? null,
      ttftMs: stats?.time_to_first_token === undefined ? null : stats.time_to_first_token * 1000,
      requests: stats?.request_count_total ?? null,
      inputTokens: stats?.input_tokens_total ?? null,
      outputTokens: stats?.output_tokens_total ?? null,
    },
    // cpuPct and memGb are real. gpuPct, vramGb and npuPct are always null on
    // this box, and not because of the hardware: Lemonade's Windows metrics
    // backend does not implement them. src/cpp/server/platform/
    // metrics_windows.cpp returns -1.0 from get_gpu_usage(),
    // get_vram_usage_gb() and get_npu_utilization() with a "not implemented
    // for Windows" comment on each, and the server maps any negative to JSON
    // null. The macOS and Linux backends do implement them, so this is a gap
    // in the port rather than in the driver — checked against upstream main,
    // 2026-08-05, running 10.8.1.
    //
    // Kept as null rather than coerced to zero: zero is a claim that the card
    // is idle, which is a different and frequently false statement.
    live: {
      cpuPct: live?.cpu_percent ?? null,
      memGb: live?.memory_gb ?? null,
      gpuPct: live?.gpu_percent ?? null,
      vramGb: live?.vram_gb ?? null,
    },
    downloads: (downloads ?? []).map((d) => ({
      model: d.model_name ?? '?',
      percent: d.percent ?? null,
      status: d.status ?? '?',
    })),
    catalog: {
      total: models.length,
      downloaded: models.filter((m) => m.downloaded === true).length,
      sizeGb: models
        .filter((m) => m.downloaded === true)
        .reduce((n, m) => n + (m.size ?? 0), 0),
    },
  }
}

/**
 * What each model has actually done, from the Lemonade scrape.
 *
 * Worth going to Prometheus rather than to Lemonade's own /api/v1/stats: that
 * endpoint reports one set of numbers for the SERVER, so it answers "how fast
 * was the last generation" and not "how fast is this model". These series
 * carry a `model_name` label and — the part that makes the picker useful —
 * they persist for models that have since been EVICTED. So a chat model you
 * are considering switching back to can show what it did last time it ran.
 *
 * Six queries in one round trip each rather than one `{__name__=~...}` match:
 * that regex form makes Prometheus scan every metric name in the index, and
 * these are cheap instant queries against a 60s-resolution job.
 */
async function modelStats(): Promise<
  Map<
    string,
    {
      type: string
      device: string | null
      backend: string | null
      stats: NonNullable<CatalogModel['stats']>
    }
  >
> {
  const names = [
    'lemonade_model_requests_total',
    'lemonade_model_input_tokens_total',
    'lemonade_model_output_tokens_total',
    'lemonade_model_tokens_per_second',
    'lemonade_model_time_to_first_token_seconds',
  ] as const

  const [requests, input, output, tps, ttft] = await Promise.all(names.map((n) => promVector(n)))

  const out = new Map<
    string,
    { type: string; device: string | null; backend: string | null; stats: NonNullable<CatalogModel['stats']> }
  >()

  const pick = (rows: typeof requests | undefined, model: string): number | null => {
    const hit = (rows ?? []).find((r) => r.metric.model_name === model)
    const n = hit === undefined ? NaN : Number(hit.value[1])
    return Number.isFinite(n) ? n : null
  }

  // Every series carries the same identity labels, so any one of them can
  // establish which models Prometheus has seen.
  for (const r of requests ?? []) {
    const model = r.metric.model_name
    if (model === undefined || out.has(model)) continue
    const ttftS = pick(ttft, model)
    out.set(model, {
      type: r.metric.type ?? 'llm',
      device: r.metric.device ?? null,
      // The scrape labels carry the recipe but not which backend build served
      // it; that only comes from the live health document.
      backend: null,
      stats: {
        requests: pick(requests, model),
        inputTokens: pick(input, model),
        outputTokens: pick(output, model),
        tps: pick(tps, model),
        ttftMs: ttftS === null ? null : ttftS * 1000,
      },
    })
  }
  return out
}

/**
 * A model's kind, when nothing authoritative has said.
 *
 * Lemonade reports `type` on the health document and on its metrics, but only
 * for models it has loaded or served since starting. A model that has never
 * run has neither, and the catalogue entry carries only free-form `labels`.
 * Those labels name every kind EXCEPT the commonest one — a chat model is
 * tagged `tool-calling`, `vision`, `mtp`, never `llm` — so the fallback is a
 * default rather than a match, which is why it is written this way round.
 */
function typeFromLabels(labels: string[] | undefined): string {
  const has = (s: string) => (labels ?? []).some((l) => l.toLowerCase().includes(s))
  if (has('embed')) return 'embedding'
  if (has('rerank')) return 'reranking'
  if (has('transcription')) return 'transcription'
  if (has('tts')) return 'tts'
  if (has('image')) return 'image'
  return 'llm'
}

/** The one recipe_option worth surfacing: which compute backend is serving. */
function pickBackend(recipe: string | undefined, opts: Record<string, unknown> | undefined): string | null {
  if (recipe === undefined || opts === undefined) return null
  const v = opts[`${recipe}_backend`] ?? opts.llamacpp_backend
  return typeof v === 'string' ? v : null
}

/** `"32.00 GB"` → 32. The vendor reports memory as a formatted string. */
function parseGb(s: string | undefined): number | null {
  const n = Number(/([\d.]+)/.exec(s ?? '')?.[1])
  return Number.isFinite(n) ? n : null
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

async function loadLitellm(): Promise<LitellmData> {
  const auth = { headers: { Authorization: `Bearer ${process.env.LITELLM_API_KEY ?? ''}` } }

  // Every day in the window, oldest first — the chart's x axis, independent of
  // which of them the ledger happens to have a row for.
  const dates = Array.from({ length: DAYS }, (_, i) =>
    new Date(Date.now() - (DAYS - 1 - i) * 86400_000).toISOString().slice(0, 10),
  )
  const from = dates[0] ?? ''
  const today = dates[DAYS - 1] ?? ''

  const [activity, version, inFlight, latSum, latCount, toolLatency, overhead] = await Promise.all([
    getJson<DailyActivity>(
      `http://litellm:4000/user/daily/activity?start_date=${from}&end_date=${today}` +
        `&page_size=${String(PAGE_SIZE)}`,
      auth,
    ),
    litellmVersion(auth),
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

  const { callers, rejected } = callersOf(days, latSum, latCount)

  const toolMs = new Map(toolLatency.map((t) => [t.label, t.value * 1000]))
  const mcp = rank(days, (d) => d.breakdown?.mcp_servers, requestsOf, (k) => k, 10).map((t) => {
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
    daily,
    today: daily.find((d) => d.date === today) ?? null,
    window: total,
    partial: activity?.metadata?.has_more === true,
    inFlight,
    overheadMs: overhead === null ? null : overhead * 1000,
    endpoints: rank(days, (d) => d.breakdown?.endpoints, requestsOf, (k) => k.replace(/^\//, '')),
    callers,
    rejected,
    mcp,
    mcpServers: [...mcp.reduce((m, t) => m.set(t.server, (m.get(t.server) ?? 0) + t.calls), new Map<string, number>())]
      .map(([name, calls]) => ({ name, calls }))
      .sort((a, b) => b.calls - a.calls),
  }
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
): { callers: Caller[]; rejected: LitellmData['rejected'] } {
  const sums = new Map(latSum.map((r) => [r.label, r.value]))
  const counts = new Map(latCount.map((r) => [r.label, r.value]))

  type Acc = Volume & { latSum: number; latCount: number; models: Set<string>; last: string }
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
      }
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
    },
  }
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

// ── Open WebUI ─────────────────────────────────────────────────────────────

async function loadOpenWebUi(base: string): Promise<OpenWebUiData> {
  const auth = { headers: { Authorization: `Bearer ${key('OPENWEBUI_KEY')}` } }

  const [usage, ver, config, models] = await Promise.all([
    getJson<{ user_count?: number; model_ids?: string[] }>(`${base}/api/usage`, auth),
    // The one service here that checks its own updates. Kept as the source of
    // `latest` even though the release gap below also has it: this is the
    // number its own UI shows, so disagreeing with it would be confusing.
    getJson<{ current?: string; latest?: string }>(`${base}/api/version/updates`, auth),
    getJson<{
      oauth?: { providers?: Record<string, string> }
      features?: { enable_login_form?: boolean; enable_signup?: boolean }
    }>(`${base}/api/config`, auth),
    getJson<{ data?: { id?: string; name?: string }[] }>(`${base}/api/models`, auth),
  ])

  const version = ver?.current ?? null

  return {
    version,
    latest: ver?.latest ?? null,
    gap: await versionGap('open-webui/open-webui', version),
    users: usage?.user_count ?? null,
    generating: usage?.model_ids?.length ?? null,
    models: (models?.data ?? [])
      .map((m) => ({ id: m.id ?? '?', name: m.name ?? m.id ?? '?' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    auth: {
      oidc: config?.oauth?.providers?.oidc ?? null,
      // Not in /api/config as a field — it is inferred from the login form
      // being off while an OIDC provider is configured, which is exactly the
      // combination that produces the redirect. See the Open WebUI stack.
      autoRedirect: config?.features?.enable_login_form === false && config.oauth?.providers?.oidc !== undefined,
      loginForm: config?.features?.enable_login_form === true,
      signup: config?.features?.enable_signup === true,
    },
  }
}

// ── n8n ────────────────────────────────────────────────────────────────────

async function loadN8n(base: string): Promise<N8nData> {
  const auth = { headers: { 'X-N8N-API-KEY': key('N8N_API_KEY') } }
  // Pinned in the flake and passed in as an env var. n8n's public API has no
  // version endpoint and /rest/settings does not carry one either, so the tag
  // the image is pinned to IS the running version — same reasoning as the
  // Factorio server's. Empty rather than absent when the nix side could not
  // parse a tag out of the pin, which is a real answer ("unknown") and not the
  // same as zero — hence `||`, which `??` would let through.
  const version = process.env.N8N_VERSION || null

  const [execs, flows] = await Promise.all([
    getJson<{ data?: { workflowId: string; status: string; startedAt: string }[] }>(
      `${base}/api/v1/executions?limit=8`,
      auth,
    ),
    getJson<{ data?: { id: string; name: string; active?: boolean }[] }>(
      `${base}/api/v1/workflows?limit=100`,
      auth,
    ),
  ])

  const workflows = (flows?.data ?? []).map((f) => ({ name: f.name, active: f.active === true }))
  const names = new Map((flows?.data ?? []).map((f) => [f.id, f.name]))
  const runs = (execs?.data ?? []).map((e) => {
    const ms = Date.parse(e.startedAt)
    return {
      name: names.get(e.workflowId) ?? e.workflowId.slice(0, 8),
      status: e.status,
      ago: Number.isFinite(ms) ? since((Date.now() - ms) / 1000) : DASH,
    }
  })

  return {
    version,
    gap: await versionGap('n8n-io/n8n', version, {
      // `n8n@2.33.4`, not `v2.33.4`. The repo also publishes moving `stable`
      // and `beta` tags, which this pattern drops by failing to match.
      tag: /^n8n@(\d+\.\d+\.\d+)$/,
      // A 1.x LTS line is published alongside 2.x and interleaved by date.
      // Without this the box is told it is dozens of releases behind, counting
      // patches to a line it is not on.
      sameMajor: true,
    }),
    workflows: workflows.sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)),
    runs,
    counts: {
      active: flows === null ? null : workflows.filter((w) => w.active).length,
      total: flows === null ? null : workflows.length,
      failed: execs === null ? null : runs.filter((r) => r.status === 'error').length,
    },
    // Both calls use the same key, so one 403 means the key, not the endpoint.
    note:
      flows === null || execs === null ?
        'n8n refused the API key. It needs a key from Settings → n8n API, in ' +
        'stacks/daedalus/service-keys.sops as N8N_API_KEY.'
      : null,
  }
}
