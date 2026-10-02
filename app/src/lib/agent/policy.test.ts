import { describe, expect, it } from 'vitest'
import { effectivePolicy, wireName, wirePolicy } from './policy'

const NAMES = {
  netName: 'gpu-box',
  lanIp: '192.0.2.10',
  lanDomain: 'lan',
  baseDomain: 'example.org',
}
const origins = (port: number) => [
  `http://gpu-box.lan:${String(port)}`,
  `http://192.0.2.10:${String(port)}`,
  'https://lemonade-gpu-box.example.org',
]

describe('the policy a machine hears', () => {
  it('is the agent’s defaults for an empty policy', () => {
    expect(wirePolicy({}, NAMES)).toEqual({
      policy: {
        awake_hold: true,
        claude_remote_control: true,
        santree: false,
        providers: { lemonade: { port: 13305, allowed_origins: origins(13305) } },
      },
      offer_lemonade: false,
      alert_link: true,
    })
  })

  it('carries the switches, a trimmed workdir, the provider port and offer, and nothing else', () => {
    const p = wirePolicy(
      {
        displayName: 'PC',
        name: 'gaming-pc',
        awakeHold: false,
        claudeRemoteControl: false,
        claudeWorkdir: ' C:/work ',
        alertLinkDown: false,
        providers: { lemonade: { port: 9000, offer: true, models: {} } },
        hardware: { finish: 'space-black' },
      },
      NAMES,
    )
    expect(p).toEqual({
      policy: {
        awake_hold: false,
        claude_remote_control: false,
        claude_workdir: 'C:/work',
        santree: false,
        providers: { lemonade: { port: 9000, allowed_origins: origins(9000) } },
      },
      offer_lemonade: true,
      alert_link: false,
    })
  })

  it('always sends santree, off unless the policy turns it on', () => {
    expect(effectivePolicy({}).santree).toBe(false)
    expect(wirePolicy({}, NAMES).policy.santree).toBe(false)
    expect(wirePolicy({ santree: false }, NAMES).policy.santree).toBe(false)
    expect(wirePolicy({ santree: true }, NAMES).policy.santree).toBe(true)
  })

  it('treats a blank workdir as none', () => {
    expect(effectivePolicy({ claudeWorkdir: '   ' }).claudeWorkdir).toBeNull()
    expect('claude_workdir' in wirePolicy({ claudeWorkdir: '   ' }, NAMES).policy).toBe(false)
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
      wirePolicy(
        {
          providers: {
            lemonade: { port: 13305, offer: true, pin, wanted: 'stop', alwaysOn: true },
          },
        },
        NAMES,
      ).policy.providers,
    ).toEqual({
      lemonade: {
        port: 13305,
        pin,
        wanted: 'stop',
        always_on: true,
        allowed_origins: origins(13305),
      },
    })
    expect(
      wirePolicy({ providers: { lemonade: { port: 13305, alwaysOn: false } } }, NAMES).policy
        .providers,
    ).toEqual({ lemonade: { port: 13305, always_on: false, allowed_origins: origins(13305) } })
  })
})

describe('the origins a machine’s Lemonade takes writes from', () => {
  it('are its LAN name, its address and its published window, and no address it has not reported', () => {
    expect(wirePolicy({}, { ...NAMES, lanIp: null }).policy.providers?.lemonade).toEqual({
      port: 13305,
      allowed_origins: ['http://gpu-box.lan:13305', 'https://lemonade-gpu-box.example.org'],
    })
  })
})
