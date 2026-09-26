import { describe, expect, it } from 'vitest'
import { flagField, nodeIdField, nonBlankField } from './fields-c'

describe('nodeIdField', () => {
  it('takes 16 lowercase hex digits, and nothing else, with the old sentence', () => {
    expect(nodeIdField('0123456789abcdef', 'id')).toBe('0123456789abcdef')
    for (const bad of ['0123456789ABCDEF', '0123456789abcde', '', 7, null, undefined]) {
      expect(() => nodeIdField(bad, 'id')).toThrow(/^expected a node id$/)
    }
  })
})

describe('flagField', () => {
  it('is on for exactly true', () => {
    expect(flagField(true, 'f')).toBe(true)
    for (const off of [false, 'true', 1, undefined, null]) expect(flagField(off, 'f')).toBe(false)
  })
})

describe('nonBlankField', () => {
  it('keeps the string untrimmed and refuses blanks with its own sentence', () => {
    const f = nonBlankField('expected a model')
    expect(f(' m ', 'm')).toBe(' m ')
    for (const bad of ['', '  ', 3, null, undefined]) {
      expect(() => f(bad, 'm')).toThrow(/^expected a model$/)
    }
  })
})
