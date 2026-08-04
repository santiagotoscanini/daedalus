// The AI category: the local model server, the gateway in front of it, and the
// two things that drive traffic through it (Open WebUI, n8n).
//
// The shape of this stack is worth keeping in mind while reading the queries:
// Lemonade runs on the gaming PC and holds several models resident at once;
// LiteLLM is the gateway every client actually talks to and is the only place
// that knows who asked for what. So "how busy is the box" comes from Lemonade
// and "who is using it" comes from LiteLLM, and neither substitutes for the
// other.

import { getJson, promScalar } from '../clients'
import { DASH, key, since } from '../format'

export type AiData = {
  headline: {
    requestsToday: number | null
    tokensToday: number | null
    modelsResident: number | null
    inFlight: number | null
    requestsSpark: number[]
  }
  /** One entry per day, oldest first. */
  daily: { date: string; requests: number; tokens: number; failed: number }[]
  /** Lemonade's resident models, most recently used first. */
  models: {
    name: string
    type: string
    device: string
    status: string
    pinned: boolean
    context: number | null
    hot: boolean
  }[]
  lemonade: {
    tps: number | null
    ttftMs: number | null
    requests: number | null
    outputTokens: number | null
    inputTokens: number | null
  }
  /** Tokens per model group over the window, from the gateway's own ledger. */
  byModel: { label: string; value: number }[]
  /** Which key (i.e. which client) is driving the traffic. */
  byClient: { label: string; value: number }[]
  /**
   * `ago` is computed here rather than in the component on purpose: a relative
   * time derived from the client's clock renders differently on the server and
   * on hydration whenever the render straddles a boundary, which React reports
   * as a hydration mismatch.
   */
  n8n: { name: string; status: string; ago: string }[]
  n8nNote: string | null
  openWebUI: { users: number | null; generating: number | null; version: string | null; latest: string | null }
}

/** How far back the gateway charts look. Two weeks fits a column per day. */
const DAYS = 14

type DayMetrics = {
  api_requests?: number
  total_tokens?: number
  failed_requests?: number
}
type Breakdown = {
  metrics?: DayMetrics
  metadata?: { key_alias?: string | null }
}
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

export async function loadAi(ctx: { base: (app: string) => string }): Promise<AiData> {
  const lemonadeBase = process.env.LEMONADE_URL ?? ''
  const litellm = { headers: { Authorization: `Bearer ${process.env.LITELLM_API_KEY ?? ''}` } }

  const from = new Date(Date.now() - (DAYS - 1) * 86400_000).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  const [activity, health, stats, owui, execs, flows, inFlight] = await Promise.all([
    // `page_size` bounds the response rather than the range: one row per day,
    // so a fortnight is a fortnight of rows and asking for more is free.
    getJson<DailyActivity>(
      `http://litellm:4000/user/daily/activity?start_date=${from}&end_date=${today}&page_size=${String(DAYS)}`,
      litellm,
    ),
    getJson<{
      all_models_loaded?: {
        model_name?: string
        type?: string
        device?: string
        status?: string
        pinned?: boolean
        last_use?: number
        max_context_window?: number
      }[]
    }>(`${lemonadeBase}/api/v1/health`),
    getJson<{
      tokens_per_second?: number
      time_to_first_token?: number
      request_count_total?: number
      output_tokens_total?: number
      input_tokens_total?: number
    }>(`${lemonadeBase}/api/v1/stats`),
    loadOpenWebUI(ctx.base('open-webui')),
    getJson<{ data?: { workflowId: string; status: string; startedAt: string }[] }>(
      `${ctx.base('n8n')}/api/v1/executions?limit=6`,
      { headers: { 'X-N8N-API-KEY': key('N8N_API_KEY') } },
    ),
    getJson<{ data?: { id: string; name: string }[] }>(`${ctx.base('n8n')}/api/v1/workflows`, {
      headers: { 'X-N8N-API-KEY': key('N8N_API_KEY') },
    }),
    promScalar('sum(litellm_in_flight_requests)'),
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

  const resident = [...(health?.all_models_loaded ?? [])].sort(
    (a, b) => (b.last_use ?? 0) - (a.last_use ?? 0),
  )

  const names = new Map((flows?.data ?? []).map((f) => [f.id, f.name]))

  return {
    headline: {
      requestsToday: todayRow?.requests ?? null,
      tokensToday: todayRow?.tokens ?? null,
      modelsResident: health === null ? null : resident.length,
      inFlight,
      requestsSpark: daily.map((d) => d.requests),
    },
    daily,
    models: resident.map((m, i) => ({
      name: m.model_name ?? '?',
      type: m.type ?? 'llm',
      device: m.device ?? '?',
      status: m.status ?? '?',
      pinned: m.pinned === true,
      context: m.max_context_window ?? null,
      // `last_use` is a monotonic counter, not a wall clock — it orders the
      // list but cannot be turned into "used 4 minutes ago". Only the top of
      // that ordering is a claim worth making, so only it gets marked.
      hot: i === 0,
    })),
    lemonade: {
      tps: stats?.tokens_per_second ?? null,
      ttftMs: stats?.time_to_first_token === undefined ? null : stats.time_to_first_token * 1000,
      requests: stats?.request_count_total ?? null,
      outputTokens: stats?.output_tokens_total ?? null,
      inputTokens: stats?.input_tokens_total ?? null,
    },
    // The gateway's per-model-group ledger over the window, not the lifetime
    // prometheus counter — the counter resets whenever litellm restarts, which
    // would make a "top models" list quietly mean "since the last deploy".
    byModel: rank(days, (d) => d.breakdown?.model_groups),
    byClient: rank(days, (d) => d.breakdown?.api_keys, (k, b) => b.metadata?.key_alias ?? k.slice(0, 8)),
    n8n: (execs?.data ?? []).map((e) => {
      const ms = Date.parse(e.startedAt)
      return {
        name: names.get(e.workflowId) ?? e.workflowId.slice(0, 8),
        status: e.status,
        ago: Number.isFinite(ms) ? since((Date.now() - ms) / 1000) : DASH,
      }
    }),
    n8nNote:
      execs?.data?.length === 0 ? 'No recent executions'
      : flows === null ? 'Workflow names need an n8n API key with workflow:read'
      : null,
    openWebUI: owui,
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

async function loadOpenWebUI(base: string): Promise<AiData['openWebUI']> {
  const h = { headers: { Authorization: `Bearer ${key('OPENWEBUI_KEY')}` } }
  const [usage, ver] = await Promise.all([
    getJson<{ user_count?: number; model_ids?: string[] }>(`${base}/api/usage`, h),
    getJson<{ current?: string; latest?: string }>(`${base}/api/version/updates`, h),
  ])
  return {
    users: usage?.user_count ?? null,
    generating: usage?.model_ids?.length ?? null,
    version: ver?.current ?? null,
    latest: ver?.latest ?? null,
  }
}
