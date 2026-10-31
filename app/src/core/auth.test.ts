import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { provenByProxy } from './auth'

// The proxy proof: anything sharing a bridge with the container can dial it,
// and only traefik holds this.

const PROOF = 'a'.repeat(64)

beforeEach(() => {
  vi.stubEnv('PROXY_PROOF', PROOF)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

const proven = (sent: string | null) => provenByProxy(() => sent)

describe('the proxy proof', () => {
  it('is absent on a request that does not carry it', () => {
    expect(proven(null)).toBe(false)
  })

  it('is absent on a wrong one, of any length', () => {
    for (const proof of ['', 'b'.repeat(64), 'a'.repeat(63), `${PROOF}a`]) {
      expect(proven(proof)).toBe(false)
    }
  })

  it('is absent when this container was given no proof to check against', () => {
    vi.stubEnv('PROXY_PROOF', '')
    expect(proven(PROOF)).toBe(false)
    expect(proven('')).toBe(false)
  })

  it('holds when it matches', () => {
    expect(proven(PROOF)).toBe(true)
  })
})
