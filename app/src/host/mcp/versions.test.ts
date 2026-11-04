import { describe, expect, it } from 'vitest'
import { pickMove } from './versions'

const mc = [
  { version: '26.4', build: '12', channel: 'stable', note: 'new game: converts the world one way' },
  { version: '26.4', build: '15', channel: 'beta', note: 'pre-release' },
  { version: '26.3', build: '230', channel: 'stable', note: null },
]

describe('pickMove', () => {
  it('takes the first offered build of a version when none is named', () => {
    expect(pickMove(mc, { version: '26.4', build: null })).toEqual(mc[0])
  })

  it('takes the named build', () => {
    expect(pickMove(mc, { version: '26.4', build: '15' })).toEqual(mc[1])
  })

  it('refuses a version or build that is not offered, naming what is', () => {
    expect(pickMove(mc, { version: '26.5', build: null })).toBe(
      '26.5 is not one of the offered moves: 26.4 build 12, 26.4 build 15, 26.3 build 230',
    )
    expect(pickMove(mc, { version: '26.4', build: '13' })).toMatch(/^26\.4 build 13 is not one/)
  })

  it('matches Factorio by version alone', () => {
    const f = [{ version: '2.1.24', build: null, channel: 'stable', note: null }]
    expect(pickMove(f, { version: '2.1.24', build: null })).toEqual(f[0])
    expect(pickMove([], { version: '2.1.24', build: null })).toBe(
      'there is nothing newer to move to',
    )
  })
})
