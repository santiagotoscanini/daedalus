import { describe, expect, it } from 'vitest'
import {
  callbackUrl,
  navigationAllowed,
  parseEnrollQuery,
  parseWgQuick,
  TYPED_LENGTH,
  typedMatches,
} from './enroll'

const KEY = 'ab'.repeat(32)
const STATE = 'S'.repeat(43)
const CHALLENGE = 'VYFANLqdx_HDV6BqEhluZJ63rtrIPROSSFdB3P6G83I'

/** A query as the agent's `enroll_url` builds it, with `over` replacing or (undefined) dropping fields. */
function query(over: Record<string, string | undefined> = {}): string {
  const base: Record<string, string | undefined> = {
    key: KEY,
    name: 'Santiagos-MacBook-Pro',
    os: 'macos',
    arch: 'aarch64',
    version: '0.23.0',
    port: '51234',
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...over,
  }
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(base)) if (v !== undefined) q.append(k, v)
  return `?${q.toString()}`
}

describe('the enroll query', () => {
  it('takes what the agent sends', () => {
    const r = parseEnrollQuery(query())
    expect(r).toEqual({
      ok: true,
      value: {
        key: KEY,
        name: 'Santiagos-MacBook-Pro',
        os: 'macos',
        arch: 'aarch64',
        version: '0.23.0',
        port: 51234,
        state: STATE,
        challenge: CHALLENGE,
      },
    })
    // A name with spaces and an apostrophe, as macOS names a machine.
    expect(parseEnrollQuery(query({ name: 'Santiago’s MacBook Pro' })).ok).toBe(true)
  })

  const refused: [string, Record<string, string | undefined>][] = [
    ['a short key', { key: 'ab'.repeat(31) }],
    ['an uppercase key', { key: 'AB'.repeat(32) }],
    ['a key that is not hex', { key: 'zz'.repeat(32) }],
    ['a missing key', { key: undefined }],
    ['an empty name', { name: '  ' }],
    ['a name with a control character', { name: 'mac\nbook' }],
    ['a name too long', { name: 'm'.repeat(65) }],
    ['an os with a space', { os: 'mac os' }],
    ['an arch too long', { arch: 'a'.repeat(33) }],
    ['a version with a slash', { version: '0.23/0' }],
    ['a port below 1024', { port: '1023' }],
    ['a port above 65535', { port: '65536' }],
    ['a port with a sign', { port: '+5000' }],
    ['a port with a fraction', { port: '5000.5' }],
    ['a port with a leading zero', { port: '05000' }],
    ['a short state', { state: 'S'.repeat(42) }],
    ['a state too long', { state: 'S'.repeat(129) }],
    ['a state with padding', { state: `${'S'.repeat(42)}=` }],
    ['a challenge one short', { code_challenge: CHALLENGE.slice(1) }],
    ['a challenge in base64, not base64url', { code_challenge: `${CHALLENGE.slice(1)}+` }],
    ['a plain challenge method', { code_challenge_method: 'plain' }],
    ['a missing challenge method', { code_challenge_method: undefined }],
  ]
  for (const [what, over] of refused) {
    it(`refuses ${what}`, () => {
      expect(parseEnrollQuery(query(over)).ok).toBe(false)
    })
  }

  it('refuses a field twice, and a field it does not know', () => {
    expect(parseEnrollQuery(`${query()}&port=5000`)).toEqual({
      ok: false,
      reason: 'port appears twice',
    })
    expect(parseEnrollQuery(`${query()}&redirect=x`)).toEqual({
      ok: false,
      reason: 'redirect is not part of a log-in link',
    })
  })

  it('never echoes a value in its reason', () => {
    const r = parseEnrollQuery(query({ name: 'evil\u0007name' }))
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).not.toContain('evil')
  })
})

describe('the typed fingerprint', () => {
  const fp = '6668:7aad:f862:bd77:6c8f:c18b:8e9f:8e20:0897:1485:6ee2:33b3:902a:591d:0d5f:2925'
  // Eight: the first two groups, 32 bits. Four (16 bits) could be ground out
  // of key generations in under a second.
  it('is the first two groups, eight hex characters, in either case', () => {
    expect(TYPED_LENGTH).toBe(8)
    expect(typedMatches(fp, '6668:7aad')).toBe(true)
    expect(typedMatches(fp, '66687aad')).toBe(true)
    expect(typedMatches('abcd:ef01', 'ABCD:EF01')).toBe(true)
    expect(typedMatches(fp, ' 6668 7aad ')).toBe(true)
  })
  it('is refused short, long or wrong', () => {
    expect(typedMatches(fp, '6668')).toBe(false)
    expect(typedMatches(fp, '6668:7aa')).toBe(false)
    expect(typedMatches(fp, '6668:7aad:f')).toBe(false)
    expect(typedMatches(fp, '6668:7aae')).toBe(false)
    expect(typedMatches('', '')).toBe(false)
  })
})

describe('the callback', () => {
  it('goes to the loopback only, with the state back and the code or the refusal', () => {
    expect(callbackUrl(51234, { state: STATE, code: 'c0de_-' })).toBe(
      `http://127.0.0.1:51234/callback?state=${STATE}&code=c0de_-`,
    )
    expect(callbackUrl(51234, { state: STATE, error: 'denied' })).toBe(
      `http://127.0.0.1:51234/callback?state=${STATE}&error=denied`,
    )
  })
})

describe('the navigation that may mint the form token', () => {
  const IDP = 'https://id.example.org'
  const nav = (site: string | null, referer: string | null = null, mode = 'navigate') => ({
    site,
    mode,
    dest: 'document',
    referer,
  })
  it('takes the menu bar opening the page, signed in or through a silent sign-in', () => {
    expect(navigationAllowed(nav('none'), IDP)).toEqual({ ok: true, value: 'direct' })
  })
  it('takes the page after a sign-in at the IdP', () => {
    expect(navigationAllowed(nav('same-site', `${IDP}/`), IDP)).toEqual({
      ok: true,
      value: 'after-sign-in',
    })
  })
  it('refuses a link from another app of the domain, and from anywhere else', () => {
    expect(navigationAllowed(nav('same-site', 'https://iris.example.org/x'), IDP).ok).toBe(false)
    expect(navigationAllowed(nav('same-site', null), IDP).ok).toBe(false)
    expect(navigationAllowed(nav('same-site', `${IDP}/`), null).ok).toBe(false)
    expect(navigationAllowed(nav('cross-site', `${IDP}/`), IDP).ok).toBe(false)
    expect(navigationAllowed(nav('same-origin'), IDP).ok).toBe(false)
  })
  it('refuses what is not a page load, and a browser that says nothing', () => {
    expect(navigationAllowed(nav('none', null, 'cors'), IDP).ok).toBe(false)
    expect(navigationAllowed({ ...nav('none'), dest: 'iframe' }, IDP).ok).toBe(false)
    expect(navigationAllowed({ site: null, mode: null, dest: null, referer: null }, IDP).ok).toBe(
      false,
    )
  })
})

/** What wg-easy 15.4.0's generateClientConfig writes, IPv6 on. */
const WG_CONF = `[Interface]
PrivateKey = oK56DE9Ue9zK76rAc8pBl6opph+1v36lm7cXXsQKrQM=
Address = 10.8.0.7/32, fdcc:ad94:bacf:61a4::cafe:7/128
MTU = 1280
DNS = 10.8.0.1

[Peer]
PublicKey = HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=
PresharedKey = FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE=
AllowedIPs = 192.168.0.2/32
PersistentKeepalive = 25
Endpoint = box.example.org:51820`

describe('the wg-quick config', () => {
  it('becomes the redeem answer’s wireguard, IPv4 alone', () => {
    expect(parseWgQuick(WG_CONF)).toEqual({
      private_key: 'oK56DE9Ue9zK76rAc8pBl6opph+1v36lm7cXXsQKrQM=',
      address: '10.8.0.7',
      server_public_key: 'HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=',
      preshared_key: 'FpCyhws9cxwWoV4xELtfJvjJN+zQVRPISllRWgeopVE=',
      endpoint: 'box.example.org:51820',
      allowed_ips: ['192.168.0.2/32'],
    })
  })
  it('leaves the preshared key out when there is none, and reads CRLF', () => {
    const c = parseWgQuick(WG_CONF.replace(/^PresharedKey.*\n/m, '').replaceAll('\n', '\r\n'))
    expect(c.preshared_key).toBeUndefined()
    expect('preshared_key' in c).toBe(false)
  })
  it('refuses what the agent would refuse, without printing a key', () => {
    const broken = [
      WG_CONF.replace(/^PrivateKey.*$/m, 'PrivateKey = nope'),
      WG_CONF.replace(/^Address.*$/m, 'Address = fdcc::7/128'),
      WG_CONF.replace(/^Endpoint.*$/m, 'Endpoint = box.example.org'),
      WG_CONF.replace(/^\[Peer\]$/m, ''),
      WG_CONF.replace(/^Endpoint.*$/m, ''),
      `${WG_CONF}\n[Peer]\nPublicKey = x`,
    ]
    for (const text of broken) {
      let message = ''
      try {
        parseWgQuick(text)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message).not.toBe('')
      expect(message).not.toContain('oK56DE9U')
    }
  })
})
