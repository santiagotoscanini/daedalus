import { describe, expect, it } from 'vitest'
import {
  apiBase,
  defaultAlias,
  lemonadeOrigins,
  modelOf,
  modeOf,
  providerUiHost,
  routeFor,
  upstreamFor,
} from './kinds'

// The gaming PC's Lemonade 10.8.1 catalog of 2026-09-23, as its agent
// carries it (agent/src/node/providers/: the provider's own words).
const CATALOG = [
  {
    id: 'Chroma1-HD',
    labels: ['custom', 'image'],
    downloaded: true,
    recipe: 'sd-cpp',
    sizeGb: 14.1,
  },
  {
    id: 'Gemma-4-12B-it-MTP-GGUF',
    labels: ['tool-calling', 'llamacpp', 'vision', 'mtp'],
    downloaded: true,
    recipe: 'llamacpp',
    sizeGb: null,
  },
  { id: 'Qwen3-Embedding-0.6B-GGUF', labels: ['embeddings'], downloaded: true },
  {
    id: 'Whisper-Large-v3-Turbo',
    labels: ['transcription', 'realtime-transcription', 'hot'],
    downloaded: true,
  },
  { id: 'bge-reranker-v2-m3-GGUF', labels: ['reranking'], downloaded: false },
  { id: 'kokoro-v1', labels: ['tts'], downloaded: true },
  { id: 'Flux-2-Klein-9B-GGUF', labels: ['image', 'edit'], downloaded: true },
].map((m) => modelOf({ sizeGb: null, recipe: null, ...m }))

describe('lemonade', () => {
  it('reads the catalog into modes and capabilities', () => {
    const m = CATALOG
    expect(m.map((x) => [x.id, x.mode])).toEqual([
      ['Chroma1-HD', 'image_generation'],
      ['Gemma-4-12B-it-MTP-GGUF', 'chat'],
      ['Qwen3-Embedding-0.6B-GGUF', 'embedding'],
      ['Whisper-Large-v3-Turbo', 'audio_transcription'],
      ['bge-reranker-v2-m3-GGUF', 'rerank'],
      ['kokoro-v1', 'audio_speech'],
      ['Flux-2-Klein-9B-GGUF', 'image_generation'],
    ])
    expect(m[1]).toMatchObject({ supportsTools: true, supportsVision: true, recipe: 'llamacpp' })
    expect(m[4]?.downloaded).toBe(false)
    expect(m[0]?.sizeGb).toBe(14.1)
  })

  it('maps labels to one mode each', () => {
    expect(modeOf(['image', 'edit'])).toBe('image_generation')
    expect(modeOf(['edit'])).toBe('image_edit')
    expect(modeOf(['custom', 'tool-calling'])).toBe('chat')
    expect(modeOf([])).toBe('chat')
  })
})

describe('the route a model becomes', () => {
  const gemma = CATALOG[1]
  if (gemma === undefined) throw new Error('fixture')

  it('is the hand-written route, derived', () => {
    const r = routeFor({
      node: 'a2272f1b0bdac468',
      kind: 'lemonade',
      base: 'http://gaming-pc.lan:13305',
      model: gemma,
      alias: 'gemma-4-12b',
      maxContext: 262144,
    })
    expect(r).toEqual({
      model_name: 'gemma-4-12b',
      litellm_params: {
        model: 'openai/Gemma-4-12B-it-MTP-GGUF',
        api_base: 'http://gaming-pc.lan:13305/api/v1',
        api_key: 'local-no-auth',
        timeout: 600,
      },
      model_info: {
        mode: 'chat',
        supports_function_calling: true,
        supports_vision: true,
        max_input_tokens: 245760,
        max_output_tokens: 16384,
        input_cost_per_token: 0,
        output_cost_per_token: 0,
        daedalus: { node: 'a2272f1b0bdac468', kind: 'lemonade', id: 'Gemma-4-12B-it-MTP-GGUF' },
      },
    })
  })

  it('routes a reranker through hosted_vllm, which posts to <api_base>/rerank', () => {
    const reranker = CATALOG[4]
    if (reranker === undefined) throw new Error('fixture')
    const r = routeFor({
      node: 'a2272f1b0bdac468',
      kind: 'lemonade',
      base: 'http://gaming-pc.lan:13305',
      model: reranker,
      alias: 'bge-reranker-v2-m3',
      maxContext: null,
    })
    expect(r.litellm_params.model).toBe('hosted_vllm/bge-reranker-v2-m3-GGUF')
    expect(r.litellm_params.api_base).toBe('http://gaming-pc.lan:13305/api/v1')
    expect(r.model_info.mode).toBe('rerank')
    expect(upstreamFor('chat', 'x')).toBe('openai/x')
  })

  it('knows where each kind hangs its OpenAI surface', () => {
    expect(apiBase('lemonade', 'http://h:13305/')).toBe('http://h:13305/api/v1')
    expect(apiBase('subgen', 'http://host.containers.internal:9000')).toBe(
      'http://host.containers.internal:9000/v1',
    )
  })

  it('names a model plainly when nobody chose an alias', () => {
    expect(defaultAlias('Gemma-4-12B-it-MTP-GGUF')).toBe('gemma-4-12b')
    expect(defaultAlias('Qwen3-Embedding-0.6B-GGUF')).toBe('qwen3-embedding-0.6b')
    expect(defaultAlias('Whisper-Large-v3-Turbo')).toBe('whisper-large-v3-turbo')
    expect(defaultAlias('kokoro-v1')).toBe('kokoro-v1')
    expect(defaultAlias('Huihui-Gemma-4-12B-uncensored')).toBe('huihui-gemma-4-12b-uncensored')
  })
})

describe('a node provider’s window', () => {
  it('is published as <kind>-<node name> for a kind that has one', () => {
    expect(providerUiHost('lemonade', 'gpu-box', 'example.org')).toBe(
      'lemonade-gpu-box.example.org',
    )
    expect(providerUiHost('subgen', 'gpu-box', 'example.org')).toBeNull()
  })

  it('is one of the origins its Lemonade takes writes from', () => {
    expect(
      lemonadeOrigins({
        netName: 'gpu-box',
        lanDomain: 'lan',
        baseDomain: 'example.org',
        port: 13305,
        lanIp: '192.0.2.10',
      }),
    ).toEqual([
      'http://gpu-box.lan:13305',
      'http://192.0.2.10:13305',
      'https://lemonade-gpu-box.example.org',
    ])
  })
})
