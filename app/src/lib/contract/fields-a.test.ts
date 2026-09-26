import { describe, expect, it } from 'vitest'
import { decode, obj, withMessage } from './decode'
import {
  nonEmptyStringField,
  pageSizeField,
  recordField,
  secretKeyField,
  stringMapField,
  taskIdField,
} from './fields-a'

describe('fields-a', () => {
  it('recordField passes a plain object on as it is, and refuses arrays and null', () => {
    const o = { a: 1 }
    expect(decode(recordField, o)).toBe(o)
    expect(() => decode(recordField, [])).toThrow()
    expect(() => decode(recordField, null)).toThrow()
  })

  it('nonEmptyStringField refuses the empty string', () => {
    expect(decode(nonEmptyStringField, 'x')).toBe('x')
    expect(() => decode(nonEmptyStringField, '')).toThrow()
    expect(() => decode(nonEmptyStringField, 1)).toThrow()
  })

  it('taskIdField refuses with taskId’s sentence', () => {
    expect(decode(taskIdField, 'nightly-sync')).toBe('nightly-sync')
    expect(() => decode(taskIdField, 'Bad Id')).toThrow(/^expected a task id$/)
  })

  it('secretKeyField refuses with secret-keys’ own sentence, through an outer withMessage', () => {
    const d = withMessage(obj({ key: secretKeyField }), 'outer')
    expect(decode(d, { key: 'API_KEY' })).toEqual({ key: 'API_KEY' })
    expect(() => decode(d, {})).toThrow(/^no variable name was given$/)
    expect(() => decode(d, null)).toThrow(/^outer$/)
  })

  it('stringMapField names the key whose value is not a string', () => {
    expect(decode(stringMapField, { a: 'b' })).toEqual({ a: 'b' })
    expect(() => decode(stringMapField, { a: 'b', n: 1 })).toThrow(/^n must be a string$/)
    expect(() => decode(stringMapField, [])).toThrow()
  })

  it('pageSizeField clamps a whole number and falls back on anything else', () => {
    const d = pageSizeField(50, 10)
    expect([0, 1, 7, 51, -3].map((v) => decode(d, v))).toEqual([1, 1, 7, 50, 1])
    expect([undefined, null, '5', 2.5, Number.NaN].map((v) => decode(d, v))).toEqual([
      10, 10, 10, 10, 10,
    ])
  })
})
