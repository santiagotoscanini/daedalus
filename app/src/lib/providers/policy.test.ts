import { describe, expect, it } from 'vitest'
import type { ProviderModel } from './kinds'
import { aliasError, isBoxProviderPolicy, modelPolicies, resolveModel } from './policy'

const gemma: ProviderModel = {
  id: 'Gemma-4-12B-it-MTP-GGUF',
  labels: ['tool-calling', 'vision'],
  mode: 'chat',
  supportsTools: true,
  supportsVision: true,
  downloaded: true,
  sizeGb: 8,
  recipe: 'llamacpp',
}

describe('a model under the operator’s policy', () => {
  it('defaults to the plain alias, offered, the labels’ mode', () => {
    expect(resolveModel(undefined, gemma)).toEqual({
      alias: 'gemma-4-12b',
      offer: true,
      mode: 'chat',
    })
  })
  it('takes what the operator set, and is never offered undownloaded', () => {
    expect(
      resolveModel({ [gemma.id]: { alias: 'gemma', offer: true, mode: 'embedding' } }, gemma),
    ).toEqual({ alias: 'gemma', offer: true, mode: 'embedding' })
    expect(resolveModel({ [gemma.id]: { offer: false } }, gemma).offer).toBe(false)
    expect(resolveModel(undefined, { ...gemma, downloaded: false }).offer).toBe(false)
  })
})

describe('the policies map from a page', () => {
  it('keeps what is valid and drops the empty', () => {
    expect(
      modelPolicies({
        a: { alias: ' Gemma ', offer: false, mode: 'chat' },
        b: {},
        c: { alias: '' },
      }),
    ).toEqual({ a: { alias: 'gemma', offer: false, mode: 'chat' } })
  })
  it('refuses what the gateway would not take', () => {
    expect(() => modelPolicies({ a: { alias: 'Bad Alias' } })).toThrow(/alias/)
    expect(() => modelPolicies({ a: { mode: 'video' } })).toThrow(/mode/)
    expect(() => modelPolicies({ a: { offer: 'yes' } })).toThrow(/offer/)
    expect(() => modelPolicies([])).toThrow(/object/)
  })
})

describe('an alias against what the gateway holds', () => {
  const taken = [
    { alias: 'gemma-4-12b', upstream: 'openai/Gemma-4-12B-it-MTP-GGUF', owner: 'config', id: null },
    { alias: 'gpt-image-2', upstream: 'openai/gpt-image-2', owner: 'config', id: null },
    { alias: 'kokoro', upstream: 'openai/kokoro-v1', owner: 'mac', id: 'kokoro-v1' },
  ]
  it('allows the migration of a config route to the same upstream', () => {
    expect(
      aliasError(
        'gemma-4-12b',
        'pc',
        'Gemma-4-12B-it-MTP-GGUF',
        'openai/Gemma-4-12B-it-MTP-GGUF',
        taken,
      ),
    ).toBeNull()
  })
  it('refuses a config route to something else, and another node’s model', () => {
    expect(aliasError('gpt-image-2', 'pc', 'Z-Image-Turbo', 'openai/Z-Image-Turbo', taken)).toMatch(
      /config\.yaml/,
    )
    expect(aliasError('kokoro', 'pc', 'kokoro-v1', 'openai/kokoro-v1', taken)).toMatch(/on mac/)
  })
  it('allows its own name and a free one', () => {
    expect(aliasError('kokoro', 'mac', 'kokoro-v1', 'openai/kokoro-v1', taken)).toBeNull()
    expect(aliasError('new-one', 'pc', 'x', 'openai/x', taken)).toBeNull()
    expect(aliasError('Bad!', 'pc', 'x', 'openai/x', taken)).toMatch(/letters/)
  })
})

describe('the box’s own policy', () => {
  it('is a subgen block or nothing', () => {
    expect(isBoxProviderPolicy({})).toBe(true)
    expect(
      isBoxProviderPolicy({
        subgen: { offer: true, models: { whisper: { alias: 'whisper-box' } } },
      }),
    ).toBe(true)
    expect(isBoxProviderPolicy({ subgen: { offer: 'x' } })).toBe(false)
    expect(isBoxProviderPolicy(null)).toBe(false)
  })
})
