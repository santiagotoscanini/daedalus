import { describe, expect, it } from 'vitest'
import {
  arrayOf,
  bool,
  DecodeError,
  decode,
  int,
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

describe('hostile input', () => {
  // Every case here decoded happily before the decoder was hardened, and each
  // one is a different way for a bad document to answer a question it was
  // never asked.

  it('recordOf stores __proto__ as a key instead of following it', () => {
    // JSON.parse makes __proto__ an OWN data property, so Object.entries
    // yields it; `out[k] = …` on a `{}` would then hit Object.prototype's
    // setter, drop the entry, and swap the result's prototype.
    const out = decode(recordOf(str), JSON.parse('{"a":"b","__proto__":"x"}'))
    expect(Object.getPrototypeOf(out)).toBeNull()
    expect(Object.hasOwn(out, '__proto__')).toBe(true)
    expect(out.a).toBe('b')

    const nested = decode(recordOf(recordOf(str)), JSON.parse('{"__proto__":{"admin":"yes"}}'))
    expect(nested.admin).toBeUndefined()
    expect(Object.keys(nested)).toEqual(['__proto__'])
  })

  it('recordOf answers nothing for a key it never decoded', () => {
    const out = decode(recordOf(str), { a: 'b' })
    expect(out.toString).toBeUndefined()
    expect(out.constructor).toBeUndefined()
    expect(out.hasOwnProperty).toBeUndefined()
  })

  it('obj reads own keys only', () => {
    const d = obj({ toString: optional(str, 'absent'), constructor: optional(str, 'absent') })
    const empty = decode(d, JSON.parse('{}'))
    expect(empty.toString).toBe('absent')
    expect(empty.constructor).toBe('absent')
    expect(decode(d, { toString: 'given' }).toString).toBe('given')
  })

  it('int refuses the numbers num rounds', () => {
    expect(decode(int, 123456)).toBe(123456)
    // 2^53 + 1 is not a double: `num` answered 9007199254740992 for it.
    expect(() => decode(int, Number.MAX_SAFE_INTEGER + 2)).toThrow('below 2^53')
    expect(() => decode(int, 1.5)).toThrow('below 2^53')
    expect(() => decode(int, Number.POSITIVE_INFINITY)).toThrow('below 2^53')
    expect(() => decode(int, Number.NaN)).toThrow('below 2^53')
    expect(() => decode(int, '3')).toThrow('expected a whole number, got string')
    // -0 round-trips through JSON as 0, so an id that keeps it fails Object.is
    // against the same id read back.
    expect(Object.is(decode(int, -0), 0)).toBe(true)
  })

  it('an array is never an object', () => {
    expect(() => decode(recordOf(str), [])).toThrow('expected an object, got array')
    expect(() => decode(obj({ a: str }), ['a'])).toThrow('expected an object, got array')
    expect(() => decode(recordOf(obj({ a: str })), { k: [] })).toThrow(
      'k: expected an object, got array',
    )
  })

  it('names the level that failed however deep it is', () => {
    const d = obj({ apps: recordOf(obj({ env: arrayOf(obj({ key: str, port: num })) })) })
    const ok = decode(d, { apps: { iris: { env: [{ key: 'A', port: 1 }] } } })
    expect(ok.apps.iris?.env[0]?.key).toBe('A')
    expect(() =>
      decode(d, { apps: { iris: { env: [{ key: 'A', port: 1 }, { key: 'B' }] } } }),
    ).toThrow('apps.iris.env[1].port: expected a finite number, got undefined')
  })
})
