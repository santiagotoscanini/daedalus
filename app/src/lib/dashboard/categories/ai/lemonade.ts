import { DASH } from '../../../format'
import { getJson } from '../../../http'
import { promVector } from '../../../prom'
import { type VersionGap, versionGap } from '../../github'

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

export type LemonadeData = {
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
  live: {
    cpuPct: number | null
    memGb: number | null
    gpuPct: number | null
    vramGb: number | null
  }
  downloads: { model: string; percent: number | null; status: string }[]
  catalog: { total: number; downloaded: number; sizeGb: number }
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

export async function loadLemonade(): Promise<LemonadeData> {
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
      sizeGb: models.filter((m) => m.downloaded === true).reduce((n, m) => n + (m.size ?? 0), 0),
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
    {
      type: string
      device: string | null
      backend: string | null
      stats: NonNullable<CatalogModel['stats']>
    }
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
function pickBackend(
  recipe: string | undefined,
  opts: Record<string, unknown> | undefined,
): string | null {
  if (recipe === undefined || opts === undefined) return null
  const v = opts[`${recipe}_backend`] ?? opts.llamacpp_backend
  return typeof v === 'string' ? v : null
}

/** `"32.00 GB"` → 32. The vendor reports memory as a formatted string. */
function parseGb(s: string | undefined): number | null {
  const n = Number(/([\d.]+)/.exec(s ?? '')?.[1])
  return Number.isFinite(n) ? n : null
}
