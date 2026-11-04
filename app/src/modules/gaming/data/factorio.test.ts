import { describe, expect, it } from 'vitest'
import { factorioOptions } from './factorio'

describe('factorioOptions', () => {
  it('offers stable when it is past the pin', () => {
    expect(factorioOptions('2.1.23', '2.1.24', '2.1.24')).toEqual([
      { version: '2.1.24', channel: 'stable' },
    ])
  })

  it('adds experimental only when it is past stable too', () => {
    expect(factorioOptions('2.1.23', '2.1.24', '2.2.1')).toEqual([
      { version: '2.1.24', channel: 'stable' },
      { version: '2.2.1', channel: 'experimental' },
    ])
  })

  it('offers experimental alone when stable is already running', () => {
    expect(factorioOptions('2.1.24', '2.1.24', '2.2.1')).toEqual([
      { version: '2.2.1', channel: 'experimental' },
    ])
  })

  it('compares part by part, so 2.1.10 is past 2.1.9', () => {
    expect(factorioOptions('2.1.9', '2.1.10', null)).toEqual([
      { version: '2.1.10', channel: 'stable' },
    ])
  })

  it('offers nothing when the pin is newest, or unknown', () => {
    expect(factorioOptions('2.2.1', '2.1.24', '2.2.1')).toEqual([])
    expect(factorioOptions(null, '2.1.24', '2.2.1')).toEqual([])
  })
})
