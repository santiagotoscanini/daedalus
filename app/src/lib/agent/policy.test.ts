import { describe, expect, it } from 'vitest'
import { effectivePolicy, wireName, wirePolicy } from './policy'

describe('the policy a machine hears', () => {
  it('is the agent’s defaults for an empty policy', () => {
    expect(wirePolicy({})).toEqual({
      policy: {
        awake_hold: true,
        claude_remote_control: true,
        santree: false,
        providers: { lemonade: { port: 13305 } },
      },
      offer_lemonade: false,
      alert_link: true,
    })
  })

  it('carries the switches, a trimmed workdir, the provider port and offer, and nothing else', () => {
    const p = wirePolicy({
      displayName: 'PC',
      name: 'gaming-pc',
      awakeHold: false,
      claudeRemoteControl: false,
      claudeWorkdir: ' C:/work ',
      alertLinkDown: false,
      providers: { lemonade: { port: 9000, offer: true, models: {} } },
      hardware: { finish: 'space-black' },
    })
    expect(p).toEqual({
      policy: {
        awake_hold: false,
        claude_remote_control: false,
        claude_workdir: 'C:/work',
        santree: false,
        providers: { lemonade: { port: 9000 } },
      },
      offer_lemonade: true,
      alert_link: false,
    })
  })

  it('always sends santree, off unless the policy turns it on', () => {
    expect(effectivePolicy({}).santree).toBe(false)
    expect(wirePolicy({}).policy.santree).toBe(false)
    expect(wirePolicy({ santree: false }).policy.santree).toBe(false)
    expect(wirePolicy({ santree: true }).policy.santree).toBe(true)
  })

  it('treats a blank workdir as none', () => {
    expect(effectivePolicy({ claudeWorkdir: '   ' }).claudeWorkdir).toBeNull()
    expect('claude_workdir' in wirePolicy({ claudeWorkdir: '   ' }).policy).toBe(false)
  })
})

describe('the name a machine is labelled with', () => {
  it('is the trimmed display name', () => {
    expect(wireName({ displayName: '  Windows PC ' })).toBe('Windows PC')
  })

  it('is absent when the controller would refuse it or has the hostname to use', () => {
    expect(wireName({})).toBeUndefined()
    expect(wireName({ displayName: '   ' })).toBeUndefined()
    expect(wireName({ displayName: 'x'.repeat(65) })).toBeUndefined()
    expect(wireName({ displayName: 'a\u0007b' })).toBeUndefined()
    expect(wireName({ displayName: 'a\u0085b' })).toBeUndefined()
    // Characters, not UTF-16 units: 64 astral characters are 64.
    expect(wireName({ displayName: '😀'.repeat(64) })).toBe('😀'.repeat(64))
  })
})

describe('a provider’s lifecycle, as the machine hears it', () => {
  it('carries the pin, wanted and always-on the policy sets, and only those', () => {
    const pin = {
      version: 'v2026.40.0',
      url: 'https://github.com/lemonade-sdk/lemonade/releases/download/v2026.40.0/lemonade.msi',
      size: 10,
      sha256: 'a'.repeat(64),
    }
    expect(
      wirePolicy({
        providers: { lemonade: { port: 13305, offer: true, pin, wanted: 'stop', alwaysOn: true } },
      }).policy.providers,
    ).toEqual({ lemonade: { port: 13305, pin, wanted: 'stop', always_on: true } })
    expect(
      wirePolicy({ providers: { lemonade: { port: 13305, alwaysOn: false } } }).policy.providers,
    ).toEqual({ lemonade: { port: 13305, always_on: false } })
  })
})
