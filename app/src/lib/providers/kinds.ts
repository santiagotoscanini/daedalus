// The provider kinds: what a machine on the network can offer the gateway,
// as one interface. A kind knows what its models are called, how one of them
// becomes a LiteLLM route, and where its OpenAI surface hangs. This file is
// the pure half: types and mappings, no network. The readers live in
// host/providers/read.ts; the AI page and the gateway sync both use them,
// and neither knows a provider by anything but its kind and machine.
//
// Two kinds cover every provider on this network today:
// - `lemonade`: Lemonade Server, OpenAI-compatible under /api/v1, a catalog
//   with labels, a health document with what is loaded. Same API and port on
//   every OS it runs on. Read by the machine's own agent and reported
//   through the controller; only the gateway's model requests dial it.
// - `subgen`: the tv stack's faster-whisper, one STT model behind
//   /v1/audio/transcriptions — a container on this box, with no catalog.
//
// Ollama is deliberately NOT a kind. Lemonade's installer brings it along,
// so a kind for it drew every Lemonade machine twice — two rows, two
// catalogs of the same weights under different names — for something the
// operator never chose. `git show 8410e1f` has the mapping if a machine ever
// runs Ollama on its own.

import { LEMONADE_DEFAULT_PORT } from '../../host/controller/generated/constants'

export type ProviderKind = 'lemonade' | 'subgen'

const PROVIDER_KINDS: readonly ProviderKind[] = ['lemonade', 'subgen']

/** Where each kind answers unless a policy names another port: the agent's own for lemonade. */
export const DEFAULT_PORT: Record<ProviderKind, number> = {
  lemonade: LEMONADE_DEFAULT_PORT,
  subgen: 9000,
}

export const PROVIDER_NAME: Record<ProviderKind, string> = {
  lemonade: 'Lemonade Server',
  subgen: 'subgen (faster-whisper)',
}

/**
 * The kinds a NODE can offer, and so the rows Settings › Machines draws for
 * one. `subgen` is left out on purpose: it is a container on this box, not
 * something a machine on the network runs, and the box contributes it from
 * its own module list (host/providers/fleet.ts). Adding a kind to this list
 * is what puts it on the page and into a node's policy.
 */
export const NODE_PROVIDER_KINDS: readonly ProviderKind[] = ['lemonade']

/**
 * The kinds whose residency the box may drive — load a model into the
 * accelerator and put it back down — rather than only read.
 *
 * Which weights are warm is runtime state, not configuration: the provider
 * loads on demand and evicts under pressure, so it drifts on its own and
 * the two things anyone wants to do about it are "free that card up" and
 * "have this one ready, I am about to use it". `subgen` is not here because
 * it serves one model and holds it for its lifetime.
 */
const MANAGED_RESIDENCY: readonly ProviderKind[] = ['lemonade']

export function managesResidency(kind: ProviderKind): boolean {
  return MANAGED_RESIDENCY.includes(kind)
}

export function isProviderKind(v: unknown): v is ProviderKind {
  return typeof v === 'string' && (PROVIDER_KINDS as readonly string[]).includes(v)
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

/* ── what a node's agent reads from its provider ──────────────────────── */

// A node's provider is read by the node's own agent, on loopback, and
// reaches this box as the providers document the controller keeps
// (agent/src/node/providers/; `nodes.providers`). The agent carries the
// provider's own words — labels, not modes — and host/controller/wire.ts
// turns them into the shapes below; nothing here dials a provider.

/**
 * What a Lemonade is busy fetching. Present only while a download runs, so
 * an empty list is the resting state rather than a failed read.
 */
export type ProviderDownload = { model: string; percent: number | null; status: string }

/**
 * An inference runtime installed at the provider, with the build serving it.
 *
 * Worth reading separately from the models: the build number is what
 * changes how fast a model runs, and it moves far more often than a
 * Lemonade release does.
 */
export type ProviderBackend = {
  recipe: string
  backend: string
  version: string | null
  url: string | null
}

/**
 * What one model has done at its provider, from the provider's own
 * `/metrics` as the agent read it. These are the running process's gauges,
 * so a provider restart resets them: nothing here is "today" or "since".
 *
 * Null rather than zero for a figure the provider never emitted: zero is a
 * claim that it ran and produced nothing. `tps` and `ttftMs` are the LAST
 * generation, not an average — the provider reports them as gauges — which
 * is exactly the figure that decides between two chat models on disk.
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

/** One catalog entry as the agent carries it, made a ProviderModel. */
export function modelOf(m: {
  id: string
  labels: string[]
  downloaded: boolean
  sizeGb: number | null
  recipe: string | null
}): ProviderModel {
  return {
    id: m.id,
    labels: m.labels,
    mode: modeOf(m.labels),
    supportsTools: m.labels.includes('tool-calling'),
    supportsVision: m.labels.includes('vision'),
    downloaded: m.downloaded,
    sizeGb: m.sizeGb,
    recipe: m.recipe,
  }
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
