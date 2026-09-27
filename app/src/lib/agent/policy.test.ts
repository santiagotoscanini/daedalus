import { describe, expect, it } from 'vitest'
import { effectivePolicy, wirePolicy } from './policy'

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
