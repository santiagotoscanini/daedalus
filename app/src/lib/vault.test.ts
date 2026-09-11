import { describe, expect, it } from 'vitest'
import { ciphertextError } from './vault'

const VALUE = 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5oQ7s'

const sopsFile = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: 'ENC[AES256_GCM,data:xyz,iv:abc,tag:def,type:str]',
    sops: {
      age: [{ recipient: 'age1…', enc: '-----BEGIN AGE ENCRYPTED FILE-----' }],
      lastmodified: '2026-09-11T12:00:00Z',
      mac: 'ENC[AES256_GCM,data:mac,iv:abc,tag:def,type:str]',
      version: '3.12.1',
    },
    ...over,
  })

describe('ciphertextError', () => {
  it('accepts a sops file for a binary secret', () => {
    expect(ciphertextError(sopsFile(), VALUE)).toBeNull()
  })

  it('refuses sops usage text, which exits 0 too', () => {
    expect(
      ciphertextError('Incorrect Usage: flag provided but not defined: -config', VALUE),
    ).toMatch(/not produce/)
  })

  it('refuses anything that carries the value, even a valid-looking file', () => {
    expect(ciphertextError(sopsFile({ note: VALUE }), VALUE)).toMatch(/value itself/)
  })

  it('refuses a file with no recipient or no MAC', () => {
    expect(ciphertextError(sopsFile({ sops: { age: [], mac: 'ENC[x]' } }), VALUE)).toMatch(
      /recipient/,
    )
    expect(ciphertextError(sopsFile({ sops: { age: [{}], mac: '' } }), VALUE)).toMatch(/MAC/)
    expect(ciphertextError(sopsFile({ data: VALUE.slice(0, 8) }), VALUE)).toMatch(/not encrypted/)
  })
})
