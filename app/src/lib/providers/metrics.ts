// What a provider's own /metrics says about each of its models.
//
// Read from the provider rather than from this box's Prometheus, though
// both carry the same series. The provider is already being dialled for
// the catalog and the health, it answers for exactly one machine, and the
// figures need no `instance` matcher to be attributed correctly — a query
// against Prometheus has to name the scrape target, and a target named
// slightly wrong returns an empty vector that looks exactly like an idle
// model. What Prometheus has and this does not is history across a
// provider restart: these gauges are the running process's, so a restart
// resets them. That is the honest trade, and it is why nothing here is
// drawn as "today" or "since" — it is what the provider has seen.
//
// The parser is the Prometheus text exposition format, the subset an
// exporter actually emits: `name{label="value",…} number`, `#` comments,
// blank lines. Escapes inside a label value are the three the format
// defines (\\, \" and \n).

export type Sample = { name: string; labels: Record<string, string>; value: number }

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(.+)$/
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g

/** The three escapes the format defines inside a label value. */
function unescaped(v: string): string {
  return v.replace(/\\(["\\n])/g, (_, c: string) => (c === 'n' ? '\n' : c))
}

export function parsePromText(text: string): Sample[] {
  const out: Sample[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = LINE.exec(line)
    if (m === null) continue
    const [, name, labelText, valueText] = m
    if (name === undefined || valueText === undefined) continue
    // A timestamp may follow the value; the value is the first field.
    const value = Number(valueText.split(/\s+/)[0])
    if (!Number.isFinite(value)) continue
    const labels: Record<string, string> = {}
    for (const l of (labelText ?? '').matchAll(LABEL)) {
      if (l[1] !== undefined && l[2] !== undefined) labels[l[1]] = unescaped(l[2])
    }
    out.push({ name, labels, value })
  }
  return out
}

/**
 * What one model has done at its provider.
 *
 * Null rather than zero for a model the provider has never served: zero is
 * a claim that it ran and produced nothing, and the two want drawing
 * differently. `tps` and `ttftMs` are the LAST generation, not an average —
 * the provider reports them as gauges — which is exactly the figure that
 * decides between two chat models already on disk.
 */
export type ModelFigures = {
  requests: number | null
  inputTokens: number | null
  outputTokens: number | null
  tps: number | null
  ttftMs: number | null
  /** The compute backend that served it, when the provider labelled it. */
  device: string | null
  /** The weights behind the name: `unsloth/gemma-4-12b-it-GGUF:Q4_K_M`. */
  checkpoint: string | null
}

const SERIES = {
  requests: 'lemonade_model_requests_total',
  inputTokens: 'lemonade_model_input_tokens_total',
  outputTokens: 'lemonade_model_output_tokens_total',
  tps: 'lemonade_model_tokens_per_second',
  ttft: 'lemonade_model_time_to_first_token_seconds',
} as const

/** Every model the provider's exposition mentions, by the id it serves it under. */
export function lemonadeFigures(text: string): Record<string, ModelFigures> {
  const out: Record<string, ModelFigures> = {}
  const blank = (): ModelFigures => ({
    requests: null,
    inputTokens: null,
    outputTokens: null,
    tps: null,
    ttftMs: null,
    device: null,
    checkpoint: null,
  })
  for (const s of parsePromText(text)) {
    const id = s.labels.model_name
    if (id === undefined || !s.name.startsWith('lemonade_model')) continue
    out[id] ??= blank()
    const f = out[id]
    f.device ??= s.labels.device ?? null
    f.checkpoint ??= s.labels.checkpoint ?? null
    switch (s.name) {
      case SERIES.requests:
        f.requests = s.value
        break
      case SERIES.inputTokens:
        f.inputTokens = s.value
        break
      case SERIES.outputTokens:
        f.outputTokens = s.value
        break
      case SERIES.tps:
        f.tps = s.value
        break
      case SERIES.ttft:
        f.ttftMs = s.value * 1000
        break
      default:
        break
    }
  }
  return out
}
