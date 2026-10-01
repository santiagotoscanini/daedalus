import { describe, expect, it } from 'vitest'
import { nodePolicyPatch } from './policy-patch'

const id = '0123456789abcdef'

describe('a change to a machine policy from the page', () => {
  it('is a change by key: the keys set, the keys cleared', () => {
    expect(nodePolicyPatch({ id, set: { awakeHold: false } })).toEqual({
      id,
      set: { awakeHold: false },
      unset: [],
    })
    expect(nodePolicyPatch({ id, set: {}, unset: ['claudeWorkdir'] })).toEqual({
      id,
      set: {},
      unset: ['claudeWorkdir'],
    })
  })
  it('clears a key set to nothing', () => {
    expect(nodePolicyPatch({ id, set: { displayName: '  ' } })).toEqual({
      id,
      set: {},
      unset: ['displayName'],
    })
    expect(nodePolicyPatch({ id, set: { pinAddress: false } }).unset).toEqual(['pinAddress'])
  })
  it('never turns santree on: that is the confirmation', () => {
    expect(() => nodePolicyPatch({ id, set: { santree: true } })).toThrow(/confirmation/)
    expect(nodePolicyPatch({ id, set: { santree: false } }).set).toEqual({ santree: false })
  })
  it('refuses a key it does not know, a bad value, and nothing at all', () => {
    expect(() => nodePolicyPatch({ id, set: { root: true } })).toThrow(/not a policy key/)
    expect(() => nodePolicyPatch({ id, unset: ['root'] })).toThrow(/not a policy key/)
    expect(() => nodePolicyPatch({ id, set: { awakeHold: 'yes' } })).toThrow(/true or false/)
    expect(() => nodePolicyPatch({ id, set: {} })).toThrow(/nothing to change/)
    expect(() => nodePolicyPatch({ id: 'x', set: { awakeHold: true } })).toThrow()
  })
})
