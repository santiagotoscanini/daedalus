import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HELLO_MAX_SKEW_SECS, nodeIdOf, verifyHello } from './hello'

/** A keypair and a signer the way the agent does it: raw ed25519, hex. */
function agent() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const pubkey = spki.subarray(spki.length - 32).toString('hex')
  return {
    pubkey,
    envelope(payload: object, sigOverride?: string) {
      const text = JSON.stringify(payload)
      const sig = sigOverride ?? sign(null, Buffer.from(text, 'utf8'), privateKey).toString('hex')
      return { payload: text, pubkey, sig }
    },
  }
}

const NOW = 1_800_000_000
const hello = (over: object = {}) => ({
  hostname: 'SANTI-PC',
  os: 'windows',
  arch: 'x86_64',
  agent_version: '0.3.0',
  mac: 'aa:bb:cc:dd:ee:ff',
  lan_ip: '192.168.0.120',
  status_port: 7787,
  os_uptime_secs: 1000,
  awake_hold: true,
  ts: NOW,
  ...over,
})

describe('verifyHello', () => {
  it('accepts a well-formed, freshly signed hello', () => {
    const a = agent()
    const v = verifyHello(a.envelope(hello()), NOW + 10)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.nodeId).toBe(nodeIdOf(a.pubkey))
    expect(v.nodeId).toHaveLength(16)
    expect(v.payload.hostname).toBe('SANTI-PC')
    expect(v.payload.statusPort).toBe(7787)
    expect(v.payload.awakeHold).toBe(true)
  })

  it('refuses a signature from another key', () => {
    const a = agent()
    const b = agent()
    const env = { ...a.envelope(hello()), pubkey: b.pubkey }
    const v = verifyHello(env, NOW)
    expect(v).toEqual({ ok: false, reason: 'the signature does not match the key' })
  })

  it('refuses a payload edited after signing', () => {
    const a = agent()
    const env = a.envelope(hello())
    env.payload = env.payload.replace('SANTI-PC', 'EVIL-PC')
    expect(verifyHello(env, NOW).ok).toBe(false)
  })

  it('refuses a stale hello even when signed', () => {
    const a = agent()
    const v = verifyHello(a.envelope(hello()), NOW + HELLO_MAX_SKEW_SECS + 1)
    expect(v).toEqual({ ok: false, reason: 'the hello is too old or too far in the future' })
  })

  it('refuses a hello from the future', () => {
    const a = agent()
    expect(verifyHello(a.envelope(hello()), NOW - HELLO_MAX_SKEW_SECS - 1).ok).toBe(false)
  })

  it('refuses malformed envelopes without touching crypto', () => {
    expect(verifyHello(null).ok).toBe(false)
    expect(verifyHello({ payload: '{}', pubkey: 'zz', sig: 'zz' }).ok).toBe(false)
    expect(verifyHello({ payload: '{}', pubkey: 'a'.repeat(64), sig: 'b'.repeat(10) }).ok).toBe(
      false,
    )
  })

  it('refuses a signed payload that is not a hello', () => {
    const a = agent()
    const v = verifyHello(a.envelope({ ts: NOW }), NOW)
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.reason).toMatch(/not a hello/)
  })

  it('fills the optional fields an older agent omits', () => {
    const a = agent()
    const v = verifyHello(
      a.envelope({ hostname: 'X', os: 'windows', agent_version: '0.3.0', ts: NOW }),
      NOW,
    )
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.payload.mac).toBeNull()
    expect(v.payload.statusPort).toBe(7787)
    expect(v.payload.arch).toBe('')
  })
})
