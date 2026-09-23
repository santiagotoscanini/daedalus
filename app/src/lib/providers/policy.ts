import { defaultAlias, type ModelMode, type ProviderModel } from './kinds'

// What the operator says about one provider model: the name the gateway
// exposes it under, whether to expose it at all, and a mode when the
// provider's labels got it wrong. Stored per node in the node's policy
// (`providers.<kind>.models[<id>]`, host/schema.ts) and, for this box's own
// provider, under the settings key `providers.box`; read by the gateway sync
// and by the AI page. Pure: the sync and Settings › Machines share it.

export type ModelPolicy = {
  alias?: string
  offer?: boolean
  mode?: ModelMode
}

/** By the provider's model id. */
export type ModelPolicies = Record<string, ModelPolicy>

export const MODEL_MODES: readonly ModelMode[] = [
  'chat',
  'embedding',
  'rerank',
  'audio_transcription',
  'audio_speech',
  'image_generation',
  'image_edit',
]

export const MODE_WORD: Record<ModelMode, string> = {
  chat: 'chat',
  embedding: 'embeddings',
  rerank: 'reranking',
  audio_transcription: 'speech to text',
  audio_speech: 'text to speech',
  image_generation: 'images',
  image_edit: 'image edits',
}

/** What the gateway accepts as a model name, kept to what a URL and a config file both take. */
export const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/

export type ResolvedModel = { alias: string; offer: boolean; mode: ModelMode }

/**
 * A model as the operator's policy leaves it: the alias they chose or the
 * id's plain form, offered unless they said not (and never when the
 * provider has not downloaded it), the mode they set or the labels' one.
 */
export function resolveModel(
  policies: ModelPolicies | undefined,
  model: ProviderModel,
): ResolvedModel {
  const p = policies?.[model.id]
  return {
    alias: p?.alias ?? defaultAlias(model.id),
    offer: model.downloaded && (p?.offer ?? true),
    mode: p?.mode ?? model.mode,
  }
}

export function isModelMode(v: unknown): v is ModelMode {
  return typeof v === 'string' && (MODEL_MODES as readonly string[]).includes(v)
}

/**
 * A policies map from a page or a store, every value checked and every
 * unknown key dropped. Throws with the reason, as the node policy
 * validator does.
 */
export function modelPolicies(v: unknown): ModelPolicies {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('models must be an object keyed by model id')
  }
  const out: ModelPolicies = {}
  for (const [id, raw] of Object.entries(v as Record<string, unknown>)) {
    if (id === '' || id.length > 200) throw new Error('a model id must be 1 to 200 characters')
    if (typeof raw !== 'object' || raw === null) throw new Error(`models.${id} must be an object`)
    const r = raw as Record<string, unknown>
    const p: ModelPolicy = {}
    if (r.alias !== undefined) {
      if (typeof r.alias !== 'string') throw new Error(`models.${id}.alias must be text`)
      const alias = r.alias.trim().toLowerCase()
      if (alias !== '') {
        if (!ALIAS_RE.test(alias)) {
          throw new Error(
            `models.${id}.alias must be letters, digits, dots, dashes or underscores, up to 63 long`,
          )
        }
        p.alias = alias
      }
    }
    if (r.offer !== undefined) {
      if (typeof r.offer !== 'boolean') throw new Error(`models.${id}.offer must be true or false`)
      p.offer = r.offer
    }
    if (r.mode !== undefined) {
      if (!isModelMode(r.mode)) throw new Error(`models.${id}.mode is not a mode the gateway knows`)
      p.mode = r.mode
    }
    if (Object.keys(p).length > 0) out[id] = p
  }
  return out
}

/** A route the gateway already has, as the collision check sees it. */
export type TakenAlias = {
  alias: string
  /** `openai/<id>` — what the route dials. */
  upstream: string
  /** Who made it: `config` for a config.yaml route, else the node id of the sync's tag. */
  owner: string
  /** The provider model id the tag names, when the sync made it. */
  id: string | null
}

/**
 * Why an alias cannot be given to this model, or null. Another node's or
 * another model's route with that name is a collision. A config.yaml route
 * with that name is one too — unless it dials the very same upstream model,
 * which is the migration of a hand-written route to a synced one: the two
 * coexist under one name until the config line is removed, and LiteLLM
 * balances between two routes to one server.
 */
export function aliasError(
  alias: string,
  owner: string,
  modelId: string,
  upstream: string,
  taken: readonly TakenAlias[],
): string | null {
  if (!ALIAS_RE.test(alias)) {
    return 'an alias is letters, digits, dots, dashes or underscores, up to 63 long'
  }
  for (const t of taken) {
    if (t.alias !== alias) continue
    if (t.owner === owner && t.id === modelId) continue
    if (t.owner === 'config') {
      if (t.upstream === upstream) continue
      return `"${alias}" is a config.yaml route to ${t.upstream}`
    }
    return `"${alias}" is already ${t.id ?? 'a model'} on ${t.owner}`
  }
  return null
}

/** The shape stored under the settings key `providers.box` for this box's own provider. */
export type BoxProviderPolicy = {
  subgen?: { offer?: boolean; models?: ModelPolicies }
}

export function isBoxProviderPolicy(v: unknown): v is BoxProviderPolicy {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const s = (v as Record<string, unknown>).subgen
  if (s === undefined) return true
  if (typeof s !== 'object' || s === null) return false
  const o = s as Record<string, unknown>
  if (o.offer !== undefined && typeof o.offer !== 'boolean') return false
  if (o.models !== undefined) {
    try {
      modelPolicies(o.models)
    } catch {
      return false
    }
  }
  return true
}

/** Mirrors lib/repo/settings.ts SETTING_KEYS.boxProviders; named here so the pure half stays free of the repository. */
export const BOX_PROVIDERS_KEY = 'providers.box'
