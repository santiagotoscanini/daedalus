import { describe, expect, it } from 'vitest'
import { DecodeError, decode } from './decode'
import { strMax } from './fields-b'

describe('strMax', () => {
  it('takes a string up to the cap, the cap included', () => {
    expect(decode(strMax(3), '')).toBe('')
    expect(decode(strMax(3), 'abc')).toBe('abc')
  })

  it('refuses a longer string and a non-string with a DecodeError', () => {
    expect(() => decode(strMax(3), 'abcd')).toThrow(DecodeError)
    expect(() => decode(strMax(3), 3)).toThrow(DecodeError)
    expect(() => decode(strMax(3), null)).toThrow(DecodeError)
  })
})
