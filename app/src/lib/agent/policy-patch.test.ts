import { describe, expect, it } from 'vitest'
import { LEMONADE_RELEASES } from '../providers/lemonade-release'
import { keepLifecycle, nodePolicyPatch } from './policy-patch'

const id = '0123456789abcdef'

const pin = {
  version: 'v2026.40.0',
  url: `${LEMONADE_RELEASES}v2026.40.0/lemonade.msi`,
  size: 10_784_768,
  sha256: 'e'.repeat(64),
}

describe('a change to a machine policy from the page', () => {
  it('is a change by key: the keys set, the keys cleared', () => {
    expect(nodePolicyPatch({ id, set: { awakeHold: false } })).toEqual({
      id,
      set: { awakeHold: false },
      unset: [],
    })
    expect(() => nodePolicyPatch({ id, set: { awakeHold: 'yes' } })).toThrow(/true or false/)
    expect(() => nodePolicyPatch({ id, set: {} })).toThrow(/nothing to change/)
    expect(() => nodePolicyPatch({ id: 'x', set: { awakeHold: true } })).toThrow()
  })

  it('takes a provider’s lifecycle keys, checked', () => {
    const lemonade = { port: 13305, offer: true, pin, wanted: 'start', alwaysOn: true }
    expect(nodePolicyPatch({ id, set: { providers: { lemonade } } }).set).toEqual({
      providers: { lemonade },
    })
    const bad = (v: object) => () =>
      nodePolicyPatch({ id, set: { providers: { lemonade: { port: 13305, offer: true, ...v } } } })
    expect(bad({ wanted: 'reboot' })).toThrow(/start or stop/)
    expect(bad({ alwaysOn: 'yes' })).toThrow(/true or false/)
    expect(bad({ pin: { ...pin, sha256: 'nope' } })).toThrow(/sha256/)
    expect(bad({ pin: { ...pin, url: 'https://example.com/lemonade.msi' } })).toThrow(/url/)
  })
})

describe('a providers save from a page', () => {
  it('keeps the lifecycle keys it does not name', () => {
    expect(
      keepLifecycle(
        { lemonade: { port: 13305, offer: true, pin, wanted: 'start', alwaysOn: false } },
        { lemonade: { port: 9000, offer: false } },
      ),
    ).toEqual({ lemonade: { port: 9000, offer: false, pin, wanted: 'start', alwaysOn: false } })
  })

  it('lets the keys it names win', () => {
    expect(
      keepLifecycle(
        { lemonade: { port: 13305, offer: true, wanted: 'start' } },
        { lemonade: { port: 13305, offer: true, wanted: 'stop' } },
      ),
    ).toEqual({ lemonade: { port: 13305, offer: true, wanted: 'stop' } })
  })

  it('is the patch itself with nothing stored', () => {
    const set = { lemonade: { port: 13305, offer: true } }
    expect(keepLifecycle(undefined, set)).toBe(set)
    expect(keepLifecycle({}, set)).toEqual(set)
  })
})
