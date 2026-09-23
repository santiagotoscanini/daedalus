import { describe, expect, it } from 'vitest'
import { lemonadeFigures, parsePromText } from './metrics'

// Lemonade 10.8.1's /metrics, as the gaming PC answered on 2026-09-23 —
// trimmed to two models so the eviction case is covered.
const EXPOSITION = `# HELP lemonade_model_info Metadata for each Lemonade model observed by this process.
# TYPE lemonade_model_info gauge
lemonade_model_info{checkpoint="unsloth/gemma-4-12b-it-GGUF:Q4_K_M",device="gpu",model_name="Gemma-4-12B-it-MTP-GGUF",recipe="llamacpp",type="llm"} 1
lemonade_model_loaded{checkpoint="unsloth/gemma-4-12b-it-GGUF:Q4_K_M",device="gpu",model_name="Gemma-4-12B-it-MTP-GGUF",recipe="llamacpp",type="llm"} 1
lemonade_model_time_to_first_token_seconds{device="gpu",model_name="Gemma-4-12B-it-MTP-GGUF",recipe="llamacpp",type="llm"} 0.10653
lemonade_model_tokens_per_second{device="gpu",model_name="Gemma-4-12B-it-MTP-GGUF",recipe="llamacpp",type="llm"} 98.755363849802663
lemonade_model_requests_total{device="gpu",model_name="Gemma-4-12B-it-MTP-GGUF",recipe="llamacpp",type="llm"} 78
lemonade_model_input_tokens_total{device="gpu",model_name="Gemma-4-12B-it-MTP-GGUF",recipe="llamacpp",type="llm"} 83850
lemonade_model_output_tokens_total{device="gpu",model_name="Gemma-4-12B-it-MTP-GGUF",recipe="llamacpp",type="llm"} 8472

lemonade_model_requests_total{device="gpu",model_name="Qwen3-Embedding-0.6B-GGUF",recipe="llamacpp",type="embedding"} 4
process_cpu_seconds_total 12.5
`

describe('the exposition parser', () => {
  it('reads a name, its labels and its value', () => {
    const s = parsePromText('a_metric{x="1",y="two"} 3.5')
    expect(s).toEqual([{ name: 'a_metric', labels: { x: '1', y: 'two' }, value: 3.5 }])
  })

  it('skips comments, blanks and anything unparseable', () => {
    expect(parsePromText('# HELP a thing\n\nnot a metric line at all!\n')).toEqual([])
  })

  it('takes a bare metric, and the value before a timestamp', () => {
    expect(parsePromText('up 1\nlagged 7 1758600000000')).toEqual([
      { name: 'up', labels: {}, value: 1 },
      { name: 'lagged', labels: {}, value: 7 },
    ])
  })

  it('unescapes what the format escapes', () => {
    const s = parsePromText('m{path="C:\\\\bin",note="a\\nb",q="say \\"hi\\""} 1')
    expect(s[0]?.labels).toEqual({ path: 'C:\\bin', note: 'a\nb', q: 'say "hi"' })
  })
})

describe('a provider’s figures', () => {
  const figures = lemonadeFigures(EXPOSITION)

  it('collects every series of a model under its id', () => {
    expect(figures['Gemma-4-12B-it-MTP-GGUF']).toEqual({
      requests: 78,
      inputTokens: 83_850,
      outputTokens: 8472,
      tps: 98.755363849802663,
      ttftMs: 106.53,
      device: 'gpu',
      checkpoint: 'unsloth/gemma-4-12b-it-GGUF:Q4_K_M',
    })
  })

  it('leaves a figure the provider did not report null, not zero', () => {
    const q = figures['Qwen3-Embedding-0.6B-GGUF']
    expect(q?.requests).toBe(4)
    expect(q?.tps).toBeNull()
    expect(q?.ttftMs).toBeNull()
    expect(q?.checkpoint).toBeNull()
  })

  it('ignores series that are not about a model', () => {
    expect(Object.keys(figures)).toEqual(['Gemma-4-12B-it-MTP-GGUF', 'Qwen3-Embedding-0.6B-GGUF'])
  })
})
