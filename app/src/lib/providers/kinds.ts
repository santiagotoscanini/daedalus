import { arrayOf, bool, type Decoder, nullable, num, obj, optional, str } from '../contract/decode'

// The provider kinds: what a machine on the network can offer the gateway,
// as one interface. A kind knows three things — how to read the catalog,
// how to read health, and how one of its models becomes a LiteLLM route.
// This file is the pure half: decoders and mappings, no network. The
// readers live in ./read.ts; the AI page and the gateway sync both use
// them, and neither knows a provider by anything but its kind and address.
//
// Three kinds cover every provider on this network today:
// - `lemonade`: Lemonade Server, OpenAI-compatible under /api/v1, a catalog
//   with labels, a health document with what is loaded. Windows today,
//   macOS with Metal the day it is installed there, same API, same port.
// - `subgen`: the tv stack's faster-whisper, one STT model behind
//   /v1/audio/transcriptions — a provider with no catalog to read.
// - `ollama`: /api/tags, chat and embeddings, the fallback for a Mac.

export type ProviderKind = 'lemonade' | 'subgen' | 'ollama'

export const PROVIDER_KINDS: readonly ProviderKind[] = ['lemonade', 'subgen', 'ollama']

export const DEFAULT_PORT: Record<ProviderKind, number> = {
  lemonade: 13305,
  subgen: 9000,
  ollama: 11434,
}

export const PROVIDER_NAME: Record<ProviderKind, string> = {
  lemonade: 'Lemonade Server',
  subgen: 'subgen (faster-whisper)',
  ollama: 'Ollama',
}

/** LiteLLM's `model_info.mode` vocabulary, the subset providers here can fill. */
export type ModelMode =
  | 'chat'
  | 'embedding'
  | 'rerank'
  | 'audio_transcription'
  | 'audio_speech'
  | 'image_generation'
  | 'image_edit'

export type ProviderModel = {
  /** The id the provider serves it under. */
  id: string
  /** The provider's own labels, kept for the page. */
  labels: string[]
  mode: ModelMode
  supportsTools: boolean
  supportsVision: boolean
  /** On disk at the provider; a catalog entry that is not is not offerable. */
  downloaded: boolean
  sizeGb: number | null
  /** The provider's recipe/backend word, when it has one. */
  recipe: string | null
}

export type ProviderHealth = {
  ok: boolean
  version: string | null
  /** Ids loaded right now, with what the provider says about each. */
  loaded: { id: string; device: string | null; maxContext: number | null; pinned: boolean }[]
}

/**
 * A Lemonade label set as a LiteLLM mode. One model, one mode: an image
 * model that also edits is `image_generation` for the gateway, and the
 * `edit` label stays on the page.
 */
export function modeOf(labels: readonly string[]): ModelMode {
  const has = (l: string) => labels.includes(l)
  if (has('embeddings') || has('embedding')) return 'embedding'
  if (has('reranking') || has('rerank')) return 'rerank'
  if (has('transcription')) return 'audio_transcription'
  if (has('tts')) return 'audio_speech'
  if (has('image')) return 'image_generation'
  if (has('edit')) return 'image_edit'
  return 'chat'
}

/* ── lemonade ─────────────────────────────────────────────────────────── */

const lemonadeEntry = obj({
  id: str,
  labels: optional(arrayOf(str), []),
  downloaded: optional(bool, false),
  size: optional(nullable(num), null),
  recipe: optional(nullable(str), null),
})

export const lemonadeCatalogDecoder: Decoder<ProviderModel[]> = (v, p) => {
  const doc = obj({ data: arrayOf(lemonadeEntry) })(v, p)
  return doc.data.map((m) => ({
    id: m.id,
    labels: m.labels,
    mode: modeOf(m.labels),
    supportsTools: m.labels.includes('tool-calling'),
    supportsVision: m.labels.includes('vision'),
    downloaded: m.downloaded,
    sizeGb: m.size,
    recipe: m.recipe,
  }))
}

export const lemonadeHealthDecoder: Decoder<ProviderHealth> = (v, p) => {
  const doc = obj({
    status: optional(str, ''),
    version: optional(nullable(str), null),
    all_models_loaded: optional(
      arrayOf(
        obj({
          model_name: str,
          device: optional(nullable(str), null),
          max_context_window: optional(nullable(num), null),
          pinned: optional(bool, false),
          loaded: optional(bool, true),
        }),
      ),
      [],
    ),
  })(v, p)
  return {
    ok: doc.status === 'ok',
    version: doc.version,
    loaded: doc.all_models_loaded
      .filter((m) => m.loaded)
      .map((m) => ({
        id: m.model_name,
        device: m.device,
        maxContext: m.max_context_window,
        pinned: m.pinned,
      })),
  }
}

/* ── ollama ───────────────────────────────────────────────────────────── */

export const ollamaTagsDecoder: Decoder<ProviderModel[]> = (v, p) => {
  const doc = obj({
    models: arrayOf(
      obj({
        name: str,
        size: optional(nullable(num), null),
        details: optional(obj({ family: optional(nullable(str), null) }), { family: null }),
      }),
    ),
  })(v, p)
  return doc.models.map((m) => {
    const embed = /embed|bge|nomic|minilm/i.test(m.name)
    return {
      id: m.name,
      labels: embed ? ['embeddings'] : [],
      mode: embed ? 'embedding' : 'chat',
      supportsTools: false,
      supportsVision: /vision|llava|vl/i.test(m.name),
      downloaded: true,
      sizeGb: m.size === null ? null : Math.round((m.size / 1e9) * 10) / 10,
      recipe: m.details.family,
    }
  })
}

/* ── subgen ───────────────────────────────────────────────────────────── */

/** subgen has no catalog: it serves one whisper model under the OpenAI path. */
export const SUBGEN_MODEL: ProviderModel = {
  id: 'whisper',
  labels: ['transcription'],
  mode: 'audio_transcription',
  supportsTools: false,
  supportsVision: false,
  downloaded: true,
  sizeGb: null,
  recipe: 'faster-whisper',
}

/* ── the route a model becomes ────────────────────────────────────────── */

export type LitellmRoute = {
  model_name: string
  litellm_params: {
    model: string
    api_base: string
    api_key: string
    timeout?: number
  }
  model_info: {
    mode: ModelMode
    supports_function_calling?: boolean
    supports_vision?: boolean
    max_input_tokens?: number
    max_output_tokens?: number
    input_cost_per_token: number
    output_cost_per_token: number
    /** The sync's mark: which node and provider made this route, so it owns it. */
    daedalus: { node: string; kind: ProviderKind; id: string }
  }
}

/** Where a kind's OpenAI-compatible surface hangs off its base URL. */
export function apiBase(kind: ProviderKind, base: string): string {
  const b = base.replace(/\/+$/, '')
  return kind === 'lemonade' ? `${b}/api/v1` : `${b}/v1`
}

/** Reserve this much of a model's context for the reply. */
const REPLY_RESERVE = 16_384

/**
 * One provider model as the LiteLLM route the sync writes. `openai/<id>` is
 * the transport, not the vendor; cost is pinned to zero so spend analytics
 * stay exact; a chat model with a known context splits it into input and
 * reply the way the hand-written routes did.
 */
export function routeFor(input: {
  node: string
  kind: ProviderKind
  base: string
  model: ProviderModel
  alias: string
  maxContext: number | null
}): LitellmRoute {
  const { model } = input
  const info: LitellmRoute['model_info'] = {
    mode: model.mode,
    input_cost_per_token: 0,
    output_cost_per_token: 0,
    daedalus: { node: input.node, kind: input.kind, id: model.id },
  }
  if (model.mode === 'chat') {
    info.supports_function_calling = model.supportsTools
    info.supports_vision = model.supportsVision
    if (input.maxContext !== null && input.maxContext > REPLY_RESERVE * 2) {
      info.max_input_tokens = input.maxContext - REPLY_RESERVE
      info.max_output_tokens = REPLY_RESERVE
    }
  }
  return {
    model_name: input.alias,
    litellm_params: {
      model: `openai/${model.id}`,
      api_base: apiBase(input.kind, input.base),
      api_key: 'local-no-auth',
      // A cold model load on a GPU box is slow; the first call after idle
      // swaps the weights in.
      timeout: model.mode === 'chat' || model.mode === 'image_generation' ? 600 : 120,
    },
    model_info: info,
  }
}

/** The alias a model gets when nobody chose one: its id, lowercased, without the packaging suffixes. */
export function defaultAlias(id: string): string {
  // Packaging words, wherever they sit: the format, the draft head, the
  // instruction-tuned suffix. What is left is what a person would say.
  return id
    .replace(/-(GGUF|MTP|it|Instruct)(?=-|$)/gi, '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-|-$/g, '')
}
