import { describe, expect, it } from 'vitest'
import { decode } from '../contract/decode'
import {
  apiBase,
  defaultAlias,
  lemonadeCatalogDecoder,
  lemonadeHealthDecoder,
  modeOf,
  ollamaTagsDecoder,
  routeFor,
} from './kinds'

// Shapes as the gaming PC's Lemonade 10.8.1 answered on 2026-09-23.
const CATALOG = {
  data: [
    {
      id: 'Chroma1-HD',
      labels: ['custom', 'image'],
      downloaded: true,
      recipe: 'sd-cpp',
      size: 14.1,
    },
    {
      id: 'Gemma-4-12B-it-MTP-GGUF',
      labels: ['tool-calling', 'llamacpp', 'vision', 'mtp'],
      downloaded: true,
      recipe: 'llamacpp',
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
  ],
}

const HEALTH = {
  status: 'ok',
  version: '10.8.1',
  model_loaded: 'Gemma-4-12B-it-MTP-GGUF',
  all_models_loaded: [
    {
      model_name: 'Gemma-4-12B-it-MTP-GGUF',
      device: 'gpu',
      max_context_window: 262144,
      pinned: false,
      loaded: true,
    },
  ],
}

describe('lemonade', () => {
  it('reads the catalog into modes and capabilities', () => {
    const m = decode(lemonadeCatalogDecoder, CATALOG)
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

  it('reads health: version and what is loaded', () => {
    const h = decode(lemonadeHealthDecoder, HEALTH)
    expect(h.ok).toBe(true)
    expect(h.version).toBe('10.8.1')
    expect(h.loaded).toEqual([
      { id: 'Gemma-4-12B-it-MTP-GGUF', device: 'gpu', maxContext: 262144, pinned: false },
    ])
  })

  it('maps labels to one mode each', () => {
    expect(modeOf(['image', 'edit'])).toBe('image_generation')
    expect(modeOf(['edit'])).toBe('image_edit')
    expect(modeOf(['custom', 'tool-calling'])).toBe('chat')
    expect(modeOf([])).toBe('chat')
  })
})

describe('ollama', () => {
  it('reads tags', () => {
    const m = decode(ollamaTagsDecoder, {
      models: [
        { name: 'llama3.2:3b', size: 2_019_393_189, details: { family: 'llama' } },
        { name: 'nomic-embed-text', size: 274_302_450 },
      ],
    })
    expect(m.map((x) => [x.id, x.mode, x.sizeGb])).toEqual([
      ['llama3.2:3b', 'chat', 2],
      ['nomic-embed-text', 'embedding', 0.3],
    ])
  })
})

describe('the route a model becomes', () => {
  const gemma = decode(lemonadeCatalogDecoder, CATALOG)[1]
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

  it('knows where each kind hangs its OpenAI surface', () => {
    expect(apiBase('lemonade', 'http://h:13305/')).toBe('http://h:13305/api/v1')
    expect(apiBase('subgen', 'http://host.containers.internal:9000')).toBe(
      'http://host.containers.internal:9000/v1',
    )
    expect(apiBase('ollama', 'http://m.lan:11434')).toBe('http://m.lan:11434/v1')
  })

  it('names a model plainly when nobody chose an alias', () => {
    expect(defaultAlias('Gemma-4-12B-it-MTP-GGUF')).toBe('gemma-4-12b')
    expect(defaultAlias('Qwen3-Embedding-0.6B-GGUF')).toBe('qwen3-embedding-0.6b')
    expect(defaultAlias('Whisper-Large-v3-Turbo')).toBe('whisper-large-v3-turbo')
    expect(defaultAlias('kokoro-v1')).toBe('kokoro-v1')
    expect(defaultAlias('Huihui-Gemma-4-12B-uncensored')).toBe('huihui-gemma-4-12b-uncensored')
  })
})
