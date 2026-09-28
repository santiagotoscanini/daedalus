import { describe, expect, it } from 'vitest'
import { effectivePolicy, wireName, wirePolicy } from './policy'

describe('the policy a machine hears', () => {
  it('is the agent’s defaults for an empty policy', () => {
    expect(wirePolicy({})).toEqual({
      awake_hold: true,
      claude_remote_control: true,
      providers: { lemonade: { port: 13305 } },
    })
  })

  it('carries the switches, a trimmed workdir and the provider port, and nothing else', () => {
    const p = wirePolicy({
      displayName: 'PC',
      name: 'gaming-pc',
      awakeHold: false,
      claudeRemoteControl: false,
      claudeWorkdir: ' C:/work ',
      providers: { lemonade: { port: 9000, offer: true, models: {} } },
      hardware: { finish: 'space-black' },
    })
    expect(p).toEqual({
      awake_hold: false,
      claude_remote_control: false,
      claude_workdir: 'C:/work',
      providers: { lemonade: { port: 9000 } },
    })
  })

  it('treats a blank workdir as none', () => {
    expect(effectivePolicy({ claudeWorkdir: '   ' }).claudeWorkdir).toBeNull()
    expect('claude_workdir' in wirePolicy({ claudeWorkdir: '   ' })).toBe(false)
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
