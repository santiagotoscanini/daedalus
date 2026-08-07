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

import { getJson, lokiLatest, promBars, promScalar, promVector } from '../clients'
import { commitsSince, versionGap, type CommitGap, type VersionGap } from '../github'
import { DASH, key, since } from '../format'

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

/**
 * One thing the chat window can reach.
 *
 * Models, tool servers and knowledge bases are three different registries
 * inside Open WebUI and one question to the reader: is everything that was
 * declared actually there. They are listed together because each of them is
 * wired from nix and each of them has a way of quietly not arriving — an
 * env-backed setting the database overrode, an MCP server a virtual key is not
 * permitted to reach, an upload that indexed nothing.
 */
type Reach = {
  kind: 'model' | 'tool' | 'knowledge'
  name: string
  detail: string
  /** Present but empty — a knowledge base holding no files. */
  flag: boolean
}

type OpenWebUiData = {
  version: string | null
  gap: VersionGap
  /** Its own update check. A second opinion on the release gap, not a repeat. */
  selfLatest: string | null
  /** Models mid-answer at this instant. */
  generating: number | null
  reach: Reach[]
  counts: { models: number; tools: number; knowledge: number }
  /** Set when the admin API refused — everything below it is then empty. */
  note: string | null
}

/**
 * One workflow: what it is, and what its executions did.
 *
 * The two halves come from two endpoints, and the union is the point. The
 * workflow list alone cannot say the nightly digest has not fired since
 * Sunday; the execution list alone cannot say a workflow is switched on and
 * has never fired at all. Each of those is a fault, and each is invisible to
 * the other endpoint.
 */
type N8nFlow = {
  id: string
  /** Null only for a workflow that ran and has since been deleted. */
  name: string | null
  /** Null when the workflow no longer exists. */
  active: boolean | null
  runs: number
  failed: number
  /** Median wall-clock of a finished run. */
  medianMs: number | null
  /** Typical gap between starts, once there are enough runs to say. */
  everyMs: number | null
  /** Words, computed here — see the note on hydration below. */
  ago: string
  /**
   * Ran on a cadence, and has since missed it.
   *
   * The one thing on this page that cannot be read off any single row: a
   * workflow that stops firing leaves no error, no failed run and no log line.
   * It just goes quiet, and the only evidence is that its own rhythm broke.
   */
  stalled: boolean
  /**
   * Edited since it was last published.
   *
   * `versionId` is the draft, `activeVersionId` is what a schedule actually
   * runs. They diverge the moment somebody edits a workflow without
   * publishing, and the symptom is "I changed it and nothing happened" — the
   * runs keep succeeding, against the old version.
   */
  unpublished: boolean
}

type N8nData = {
  version: string | null
  gap: VersionGap
  /** Every day of the window, oldest first — including the empty ones. */
  daily: { date: string; runs: number; failed: number }[]
  window: { days: number; runs: number; failed: number; running: number; medianMs: number | null }
  /** Busiest first. */
  flows: N8nFlow[]
  /**
   * The failures themselves, newest first.
   *
   * Few enough to name — one in a fortnight here — which is the whole reason
   * this is a list and the rejected keys on the gateway tab are a count.
   */
  failures: {
    name: string
    /**
     * Computed here rather than in the component on purpose: a relative time
     * derived from the client's clock renders differently on the server and on
     * hydration whenever the render straddles a boundary, which React reports
     * as a hydration mismatch.
     */
    ago: string
  }[]
  /** True when there were more executions than this fetched. */
  partial: boolean
  /** Archived workflows, which are excluded from `flows` entirely. */
  archived: number
  /** Set when the executions API refused, which leaves the page with nothing. */
  note: string | null
  /** Set when the workflow list refused, which costs names and liveness. */
  nameNote: string | null
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

  const [activity, keys, version, inFlight, latSum, latCount, toolLatency, overhead] =
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
    keys === null || (keys.total_pages ?? 1) > 1 ?
      null
    : new Set((keys.keys ?? []).map((k) => k.token ?? '')),
  )

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
      note: 'The one MCP server that runs on this box — TickTick is remote and logs nothing here. Every call counted in “tools models called” above passed through this container.',
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

const GONE = 'No key with this hash exists on the gateway any more — it was deleted or rotated, which is usually the whole explanation for a caller that succeeded and then failed forever.'

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
    'The admin credential, so this row is every consumer configured with it at once — Open WebUI (chat, RAG embeddings, transcription, speech, images), the pgvector connector, and this dashboard. Giving each its own aliased key is what would split them apart.',
  'health check':
    'LiteLLM testing its own deployments. Not a status ping — it sends a real minimal request to each one, which is why it has tokens against it. Triggered on demand, from the admin UI or /health, rather than on a schedule.',
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

/**
 * The chat window, as three registries and a door.
 *
 * What this page deliberately does NOT report is usage. Open WebUI knows how
 * many chats it holds and could be made to draw them, and on a household
 * instance with one account that number is vanity: it goes up when somebody
 * talks to a model, which is the thing the model server's own tab measures
 * properly, per model, with latency. Counting it a second time here would be a
 * chart of the same fact with less in it.
 *
 * What is worth reading off a running instance is everything a restart could
 * silently take away: the models the picker offers, the tool servers that
 * registered, the knowledge bases that hold anything.
 *
 * Nor does it report how sign-in is configured. That was four facts —
 * identity provider, login form off, sign-up closed — every one of them
 * declared in stacks/open-webui and none of them able to say anything the file
 * does not. `/api/config` and `/api/v1/users/` are not fetched at all now,
 * which is the point: a panel nobody reads still costs two requests on every
 * page load.
 */
async function loadOpenWebUi(base: string): Promise<OpenWebUiData> {
  const auth = { headers: { Authorization: `Bearer ${key('OPENWEBUI_KEY')}` } }

  const [usage, ver, models, knowledge, tools] = await Promise.all([
    getJson<{ model_ids?: string[] }>(`${base}/api/usage`, auth),
    // The one service here that checks its own updates, which is why it is
    // kept alongside the release gap rather than replaced by it: two
    // independent answers to "is this current", and them disagreeing is
    // itself worth seeing.
    getJson<{ current?: string; latest?: string }>(`${base}/api/version/updates`, auth),
    getJson<{ data?: { id?: string; name?: string }[] }>(`${base}/api/models`, auth),
    getJson<{ items?: { name?: string; file_count?: number }[] }>(`${base}/api/v1/knowledge/`, auth),
    getJson<{ name?: string; meta?: { description?: string } }[]>(`${base}/api/v1/tools/`, auth),
  ])

  const version = ver?.current ?? null
  const modelList = models?.data ?? []
  const toolList = tools ?? []
  const kbList = knowledge?.items ?? []

  // Models first, then tools, then knowledge: the order a request uses them.
  const reach: Reach[] = [
    ...modelList.map((m) => ({
      kind: 'model' as const,
      name: m.name ?? m.id ?? '?',
      detail: m.id ?? '?',
      flag: false,
    })),
    ...toolList.map((t) => ({
      kind: 'tool' as const,
      name: t.name ?? '?',
      detail: t.meta?.description ?? '',
      flag: false,
    })),
    ...kbList.map((k) => {
      const files = k.file_count ?? 0
      return {
        kind: 'knowledge' as const,
        name: k.name ?? '?',
        detail: `${String(files)} file${files === 1 ? '' : 's'}`,
        // A collection with nothing in it answers no question it is asked, and
        // reports no error while doing so.
        flag: files === 0,
      }
    }),
  ]

  return {
    version,
    gap: await versionGap('open-webui/open-webui', version),
    selfLatest: ver?.latest ?? null,
    generating: usage?.model_ids?.length ?? null,
    reach,
    counts: { models: modelList.length, tools: toolList.length, knowledge: kbList.length },
    // The admin endpoints share one key, so one refusal is the key rather than
    // the endpoint. Tested on tools rather than models: /api/models answers
    // for any authenticated caller, so it cannot tell an admin key from a
    // useless one.
    note:
      tools === null ?
        'Open WebUI refused the admin API. It needs a key from Account → API Keys, in ' +
        'stacks/daedalus/service-keys.sops as OPENWEBUI_KEY.'
      : null,
  }
}

// ── n8n ────────────────────────────────────────────────────────────────────

type Execution = {
  workflowId: string
  status: string
  startedAt: string
  stoppedAt?: string | null
}

/** n8n's page cap is 250; four pages is a fortnight of this box several times over. */
const EXEC_PAGES = 4

/**
 * Every execution n8n still holds, up to a bound.
 *
 * Paged because the interesting figures here — a per-day column, a per-workflow
 * median, a cadence — are all aggregates, and an aggregate over the first page
 * is not an aggregate. `partial` says when the bound was hit rather than
 * letting a truncated window pass for a complete one.
 */
async function listExecutions(
  base: string,
  auth: RequestInit,
): Promise<{ rows: Execution[]; refused: boolean; partial: boolean }> {
  const rows: Execution[] = []
  let cursor: string | null = null

  for (let page = 0; page < EXEC_PAGES; page++) {
    // Annotated and hoisted: inline, the URL's type would depend on `cursor`'s
    // narrowing, which depends on the assignment below it, which depends on
    // this call — a cycle TypeScript refuses to resolve.
    const next: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
    const body = await getJson<{ data?: Execution[]; nextCursor?: string | null }>(
      `${base}/api/v1/executions?limit=250${next}`,
      auth,
    )
    // A refusal on the first page is the key; on a later one it is a partial
    // answer, and the rows already in hand are still worth drawing.
    if (body === null) return { rows, refused: page === 0, partial: page > 0 }
    rows.push(...(body.data ?? []))
    cursor = body.nextCursor ?? null
    if (cursor === null) return { rows, refused: false, partial: false }
  }
  return { rows, refused: false, partial: true }
}

/** `YYYY-MM-DD` in the box's timezone, so a column is the day you lived. */
const localDay = (ms: number): string => new Date(ms).toLocaleDateString('en-CA')

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? null
}

const FAILED = new Set(['error', 'crashed'])
const RUNNING = new Set(['running', 'new', 'waiting'])

/**
 * n8n, read from its executions.
 *
 * Built from BOTH endpoints, unioned. Executions carry what actually happened
 * — did it run, did it work, how long it took, on what rhythm — and nothing
 * here runs on a person being awake, so those are the questions. The workflow
 * list carries what is supposed to happen, and contributes the two facts no
 * execution can: a workflow that is switched on and has never fired, and one
 * whose draft has drifted ahead of the version its schedule actually runs.
 *
 * Archived workflows are dropped outright. Six of the eleven on this box are
 * archived TickTick experiments; they cannot run, and listing them would bury
 * the two that can under things that are finished.
 */
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
    listExecutions(base, auth),
    getJson<{
      data?: {
        id: string
        name: string
        active?: boolean
        isArchived?: boolean
        versionId?: string | null
        activeVersionId?: string | null
      }[]
    }>(`${base}/api/v1/workflows?limit=250`, auth),
  ])

  const all = flows?.data ?? []
  const live = all.filter((f) => f.isArchived !== true)
  const known = new Map(live.map((f) => [f.id, f]))
  const now = Date.now()
  const floor = now - DAYS * 86400_000

  // Clamped to the window the chart draws, so the measure line beside it
  // counts the same runs. n8n prunes its own history well inside a fortnight,
  // so in practice this drops nothing.
  const rows = execs.rows
    .map((e) => ({ ...e, at: Date.parse(e.startedAt) }))
    .filter((e) => Number.isFinite(e.at) && e.at >= floor)
    .sort((a, b) => b.at - a.at)

  const dates = Array.from({ length: DAYS }, (_, i) => localDay(now - (DAYS - 1 - i) * 86400_000))
  const byDate = new Map(dates.map((d) => [d, { date: d, runs: 0, failed: 0 }]))
  for (const e of rows) {
    const day = byDate.get(localDay(e.at))
    if (day === undefined) continue
    day.runs++
    if (FAILED.has(e.status)) day.failed++
  }

  const perFlow = new Map<string, typeof rows>()
  // Seeded with every ACTIVE workflow, so one that is switched on and has
  // never fired gets a row saying so instead of being absent — which is the
  // state it would otherwise share with a workflow that does not exist. Not
  // the inactive ones: a parked draft with no runs is a row that says "off,
  // nothing", which is true of every draft anybody ever abandoned.
  for (const f of live) if (f.active === true) perFlow.set(f.id, [])
  // Archiving a workflow keeps its executions, so the runs it made before
  // being shelved would otherwise put it back on the page.
  const archivedIds = new Set(all.filter((f) => f.isArchived === true).map((f) => f.id))
  for (const e of rows) {
    if (archivedIds.has(e.workflowId)) continue
    perFlow.set(e.workflowId, [...(perFlow.get(e.workflowId) ?? []), e])
  }

  const flowRows: N8nFlow[] = [...perFlow].map(([id, mine]) => {
    const meta = known.get(id)
    const last = mine[0]?.at ?? now
    const durations = mine
      .filter((e) => typeof e.stoppedAt === 'string' && e.stoppedAt !== '')
      .map((e) => Date.parse(e.stoppedAt ?? '') - e.at)
      .filter((d) => Number.isFinite(d) && d >= 0)
    // Gaps between consecutive starts, newest-first list walked backwards.
    const gaps = mine.slice(1).map((e, i) => (mine[i]?.at ?? 0) - e.at)
    const every = mine.length >= 4 ? median(gaps) : null

    return {
      id,
      name: meta?.name ?? null,
      active: meta === undefined ? null : meta.active === true,
      runs: mine.length,
      failed: mine.filter((e) => FAILED.has(e.status)).length,
      medianMs: median(durations),
      everyMs: every,
      // An empty bucket has no last run, and `now` would render "just now" —
      // the opposite of the truth. The view keys off `runs === 0` instead.
      ago: mine.length === 0 ? DASH : since((now - last) / 1000),
      // Only meaningful for a workflow that HAS a published version: a draft
      // nobody ever published has `activeVersionId: null`, which is "off", not
      // "drifted".
      unpublished:
        meta?.activeVersionId != null &&
        meta.versionId != null &&
        meta.versionId !== meta.activeVersionId,
      // Two and a half cycles of silence, not one: a daily job that slips a few
      // hours is normal, and a claim that fires on a normal day is a claim
      // nobody reads twice. A workflow known to be switched off is not stalled,
      // it is off.
      stalled: every !== null && every > 0 && now - last > every * 2.5 && meta?.active !== false,
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
    daily: dates.map((d) => byDate.get(d) ?? { date: d, runs: 0, failed: 0 }),
    window: {
      days: DAYS,
      runs: rows.length,
      failed: rows.filter((e) => FAILED.has(e.status)).length,
      running: rows.filter((e) => RUNNING.has(e.status)).length,
      medianMs: median(
        rows
          .filter((e) => typeof e.stoppedAt === 'string' && e.stoppedAt !== '')
          .map((e) => Date.parse(e.stoppedAt ?? '') - e.at)
          .filter((d) => Number.isFinite(d) && d >= 0),
      ),
    },
    // By runs, because the bar beside each row is a ranking and a ranking that
    // is not sorted by its own bar is unreadable. A switched-on workflow that
    // has never fired therefore lands at the bottom, which is why it carries a
    // badge rather than relying on its position to be noticed.
    flows: flowRows.sort((a, b) => b.runs - a.runs || (a.name ?? a.id).localeCompare(b.name ?? b.id)),
    failures: rows
      .filter((e) => FAILED.has(e.status))
      .slice(0, 6)
      .map((e) => ({
        name: known.get(e.workflowId)?.name ?? e.workflowId.slice(0, 8),
        ago: since((now - e.at) / 1000),
      })),
    partial: execs.partial,
    archived: all.length - live.length,
    note:
      execs.refused ?
        'n8n refused the executions API. The key needs the execution:read scope — make one ' +
        'in Settings → n8n API and put it in stacks/daedalus/service-keys.sops as N8N_API_KEY.'
      : null,
    // A different, smaller problem than the one above, and worth saying
    // separately: the runs still count, the rows are just labelled with ids
    // and lose their on/off state.
    nameNote:
      !execs.refused && flows === null ?
        'The API key cannot read workflows, so these are ids and their on/off state is unknown. ' +
        'Re-issue it in Settings → n8n API with the workflow:read scope.'
      : null,
  }
}
