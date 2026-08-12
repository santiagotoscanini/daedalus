import { describe, expect, it } from 'vitest'
import {
  arrayOf,
  bool,
  DecodeError,
  decode,
  literal,
  nullable,
  num,
  obj,
  optional,
  recordOf,
  str,
} from './decode'

describe('primitives', () => {
  it('accept their type and refuse the rest with the path', () => {
    expect(decode(str, 'x')).toBe('x')
    expect(decode(num, 1.5)).toBe(1.5)
    expect(decode(bool, true)).toBe(true)
    expect(() => decode(str, 1)).toThrow('expected a string, got number')
    expect(() => decode(num, Number.NaN)).toThrow('finite number')
    expect(() => decode(num, '1')).toThrow('got string')
    expect(() => decode(bool, null)).toThrow('got null')
  })
})

describe('combinators', () => {
  it('literal names its alternatives', () => {
    const stage = literal('off', 'lab', 'live')
    expect(decode(stage, 'lab')).toBe('lab')
    expect(() => decode(stage, 'prod')).toThrow('off | lab | live')
  })

  it('nullable and optional are different absences', () => {
    expect(decode(nullable(str), null)).toBeNull()
    expect(() => decode(nullable(str), undefined)).toThrow(DecodeError)
    expect(decode(optional(str, 'dflt'), undefined)).toBe('dflt')
    expect(() => decode(optional(str, 'dflt'), null)).toThrow(DecodeError)
  })

  it('arrayOf and recordOf index their error paths', () => {
    expect(decode(arrayOf(num), [1, 2])).toEqual([1, 2])
    expect(() => decode(arrayOf(num), [1, 'x'])).toThrow('[1]: expected a finite number')
    expect(decode(recordOf(bool), { a: true })).toEqual({ a: true })
    expect(() => decode(recordOf(bool), { a: true, b: 1 })).toThrow('.b')
  })

  it('obj checks its shape, dots its paths, ignores unknown keys', () => {
    const d = obj({ name: str, port: optional(num, 3000) })
    expect(decode(d, { name: 'x', extra: 'ignored' })).toEqual({ name: 'x', port: 3000 })
    expect(() => decode(d, { name: 1 })).toThrow('name: expected a string')
    expect(() => decode(d, [])).toThrow('expected an object, got array')

    const nested = obj({ auth: obj({ mode: str }) })
    expect(() => decode(nested, { auth: { mode: 7 } })).toThrow('auth.mode')
  })
})
