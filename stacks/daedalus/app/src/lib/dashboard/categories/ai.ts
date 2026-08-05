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

type LitellmData = {
  version: string | null
  gap: VersionGap
  headline: {
    requestsToday: number | null
    tokensToday: number | null
    inFlight: number | null
    failedToday: number | null
    requestsSpark: number[]
  }
  daily: { date: string; requests: number; tokens: number; failed: number }[]
  byModel: { label: string; value: number }[]
  byClient: { label: string; value: number }[]
  /** What each published model name actually resolves to. */
  routes: { name: string; target: string; mode: string; upstream: string }[]
  /** Mean end-to-end latency per model, from the gateway's own histogram. */
  latency: { label: string; value: number }[]
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
type Breakdown = { metrics?: DayMetrics; metadata?: { key_alias?: string | null } }
type DailyActivity = {
  results?: {
    date?: string
    metrics?: DayMetrics
    breakdown?: {
      model_groups?: Record<string, Breakdown>
      api_keys?: Record<string, Breakdown>
    }
  }[]
}

async function loadLitellm(): Promise<LitellmData> {
  const auth = { headers: { Authorization: `Bearer ${process.env.LITELLM_API_KEY ?? ''}` } }

  const from = new Date(Date.now() - (DAYS - 1) * 86400_000).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  const [activity, routes, version, inFlight, latency] = await Promise.all([
    // `page_size` bounds the response rather than the range: one row per day,
    // so a fortnight is a fortnight of rows and asking for more is free.
    getJson<DailyActivity>(
      `http://litellm:4000/user/daily/activity?start_date=${from}&end_date=${today}&page_size=${String(DAYS)}`,
      auth,
    ),
    getJson<{
      data?: {
        model_name?: string
        litellm_params?: { model?: string; api_base?: string }
        model_info?: { mode?: string }
      }[]
    }>('http://litellm:4000/model/info', auth),
    litellmVersion(auth),
    promScalar('sum(litellm_in_flight_requests)'),
    // Mean seconds per request from the histogram's own sum/count, which is
    // the only honest average available: the buckets are coarse enough that a
    // quantile over this little traffic would be quantisation noise.
    promBars(
      'sum by (model) (increase(litellm_request_total_latency_metric_sum[24h]))' +
        ' / sum by (model) (increase(litellm_request_total_latency_metric_count[24h]))',
      'model',
    ),
  ])

  // Oldest-first: the API returns newest-first, and a chart that reads
  // right-to-left is a chart nobody reads correctly.
  const days = [...(activity?.results ?? [])].reverse()
  const daily = days.map((d) => ({
    date: d.date ?? '',
    requests: d.metrics?.api_requests ?? 0,
    tokens: d.metrics?.total_tokens ?? 0,
    failed: d.metrics?.failed_requests ?? 0,
  }))
  const todayRow = daily.find((d) => d.date === today)

  return {
    version,
    gap: await versionGap('BerriAI/litellm', version),
    headline: {
      requestsToday: todayRow?.requests ?? null,
      tokensToday: todayRow?.tokens ?? null,
      failedToday: todayRow?.failed ?? null,
      inFlight,
      requestsSpark: daily.map((d) => d.requests),
    },
    daily,
    // The gateway's per-model-group ledger over the window, not the lifetime
    // prometheus counter — the counter resets whenever litellm restarts, which
    // would make a "top models" list quietly mean "since the last deploy".
    byModel: rank(days, (d) => d.breakdown?.model_groups),
    byClient: rank(days, (d) => d.breakdown?.api_keys, (k, b) => b.metadata?.key_alias ?? k.slice(0, 8)),
    routes: (routes?.data ?? [])
      .map((m) => ({
        name: m.model_name ?? '?',
        target: (m.litellm_params?.model ?? '').replace(/^openai\//, ''),
        mode: m.model_info?.mode ?? 'chat',
        // Host only. The full base URL is the same string thirteen times over
        // and its path adds nothing — what varies, and what matters, is which
        // machine is answering.
        upstream: hostOf(m.litellm_params?.api_base),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    latency: latency.map((l) => ({ label: l.label, value: l.value * 1000 })),
  }
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

function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').host
  } catch {
    return DASH
  }
}

/** Sum a per-day breakdown map into a ranked top-6. */
function rank(
  days: NonNullable<DailyActivity['results']>,
  pick: (d: NonNullable<DailyActivity['results']>[number]) => Record<string, Breakdown> | undefined,
  label: (k: string, b: Breakdown) => string = (k) => k,
): { label: string; value: number }[] {
  const totals = new Map<string, number>()
  for (const d of days) {
    for (const [k, b] of Object.entries(pick(d) ?? {})) {
      const name = label(k, b)
      totals.set(name, (totals.get(name) ?? 0) + (b.metrics?.total_tokens ?? 0))
    }
  }
  return [...totals]
    .map(([l, value]) => ({ label: l, value }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 6)
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
