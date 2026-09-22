import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Ctx, gatewayOf } from '../../../core/ctx'
import { loadLitellm } from './litellm'

afterEach(() => vi.unstubAllGlobals())

describe('the gateway capability', () => {
  it('is both halves or nothing', () => {
    expect(gatewayOf('http://litellm:4000', 'sk-1')).toEqual({
      baseUrl: 'http://litellm:4000',
      apiKey: 'sk-1',
    })
    expect(gatewayOf('http://litellm:4000', undefined)).toBeNull()
    expect(gatewayOf(undefined, 'sk-1')).toBeNull()
    expect(gatewayOf(undefined, undefined)).toBeNull()
  })
})

describe('the LiteLLM tab on a box without a gateway', () => {
  it('answers "not configured" without throwing or dialling anything', async () => {
    const fetched = vi.fn(() => Promise.reject(new Error('nothing may be fetched')))
    vi.stubGlobal('fetch', fetched)
    // Only `gateway` and the published hostname (a local fact, not a dial)
    // are read before the early return; any other capability being touched
    // is the failure this test exists to catch.
    const hosts: Ctx['hosts'] = { base: (app) => `https://${app}.example.org`, hc: '' }
    const ctx = new Proxy({ gateway: null, hosts } as unknown as Ctx, {
      get: (target, prop) => {
        if (prop === 'gateway') return target.gateway
        if (prop === 'hosts') return target.hosts
        throw new Error(`the loader reached for ctx.${String(prop)}`)
      },
    })

    const data = await loadLitellm(ctx)

    expect(data.configured).toBe(false)
    expect(data.url).toBe('https://litellm.example.org')
    expect(data.daily).toEqual([])
    expect(data.callers).toEqual([])
    expect(data.neighbours).toEqual([])
    expect(fetched).not.toHaveBeenCalled()
  })
})
