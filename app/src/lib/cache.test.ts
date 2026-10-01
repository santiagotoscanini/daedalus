import { describe, expect, it } from 'vitest'
import { swrCache } from './cache'

// Concurrent misses on one key are one load: a page whose several boards ask
// for the same release list at once must not ask the upstream that many times.

describe('swrCache', () => {
  it('shares one load between callers that miss the same key at once', async () => {
    const cache = swrCache({ ttlMs: 60_000 })
    let loads = 0
    let release: (v: string) => void = () => undefined
    const load = () => {
      loads++
      return new Promise<string>((r) => {
        release = r
      })
    }
    const a = cache.get('k', load)
    const b = cache.get('k', load)
    release('v')
    expect(await Promise.all([a, b])).toEqual(['v', 'v'])
    expect(loads).toBe(1)
    // And the answer is kept: the next read inside the TTL loads nothing.
    expect(await cache.get('k', load)).toBe('v')
    expect(loads).toBe(1)
  })

  it('lets the next miss load again once a shared load threw', async () => {
    const cache = swrCache({ ttlMs: 60_000 })
    await expect(cache.get('k', () => Promise.reject(new Error('down')))).rejects.toThrow('down')
    expect(await cache.get('k', async () => 'up')).toBe('up')
  })
})
