import { describe, expect, it } from 'vitest'
import { ciphertextError, jsonCiphertextError, jsonVaultValuesError, VAULT_FILES } from './vault'

const VALUE = 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5oQ7s'

const sopsFile = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    data: 'ENC[AES256_GCM,data:xyz,iv:abc,tag:def,type:str]',
    sops: {
      age: [{ recipient: 'age1…', enc: '-----BEGIN AGE ENCRYPTED FILE-----' }],
      lastmodified: '2026-09-11T12:00:00Z',
      mac: 'ENC[AES256_GCM,data:mac,iv:abc,tag:def,type:str]',
      version: '3.12.1',
    },
    ...over,
  })

describe('ciphertextError', () => {
  it('accepts a sops file for a binary secret', () => {
    expect(ciphertextError(sopsFile(), VALUE)).toBeNull()
  })

  it('refuses sops usage text, which exits 0 too', () => {
    expect(
      ciphertextError('Incorrect Usage: flag provided but not defined: -config', VALUE),
    ).toMatch(/not produce/)
  })

  it('refuses anything that carries the value, even a valid-looking file', () => {
    expect(ciphertextError(sopsFile({ note: VALUE }), VALUE)).toMatch(/value itself/)
  })

  it('refuses a file with no recipient or no MAC', () => {
    expect(ciphertextError(sopsFile({ sops: { age: [], mac: 'ENC[x]' } }), VALUE)).toMatch(
      /recipient/,
    )
    expect(ciphertextError(sopsFile({ sops: { age: [{}], mac: '' } }), VALUE)).toMatch(/MAC/)
    expect(ciphertextError(sopsFile({ data: VALUE.slice(0, 8) }), VALUE)).toMatch(/not encrypted/)
  })
})

describe('VAULT_FILES', () => {
  it('allowlists the GitHub App file beside the existing entries', () => {
    expect(VAULT_FILES).toContain('vault/github-app.sops')
    expect(VAULT_FILES).toContain('vault/cloudflare-api-token.sops')
    expect(VAULT_FILES).toContain('vault/github-token.sops')
  })
})

// A throwaway key shape, not a real key: realistic line lengths are what the
// body-line check depends on.
const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAtY2ZkZ3hvbm9yZXRlc3RrZXlub3RyZWFsbm90cmVhbG5vdHJl',
  'YWxub3RyZWFsbm90cmVhbG5vdHJlYWxub3RyZWFsbm90cmVhbG5vdHJlYWxub3Ry',
  'ZWFsbm90cmVhbA==',
  '-----END RSA PRIVATE KEY-----',
  '',
].join('\n')

const APP = {
  pem: PEM,
  webhookSecret: 'f3b1c9d27e4a8b6c0d5e2f7a9b3c1d8e6f4a2b0c',
  clientSecret: '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d',
}

const enc = (data: string) =>
  `ENC[AES256_GCM,data:${data},iv:68AkvJefBblBsGRCRZCmgeyeb/d6gheuKQGyhopp878=,tag:u/jkw3RRZfSghKPAlkTQ9w==,type:str]`

// The shape sops 3.12 writes for `--output-type json`: the input's keys in
// order, each value its own ENC[…], then the metadata block (two age
// recipients, as site/.sops.yaml names).
const appFile = (over: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      pem: enc('z1cHpUkog0s64nBLa0M8HBumxhWFZl15xBlXR4Q2TuHZCIYUkz0IAQ=='),
      webhookSecret: enc('Q2TuHZCIYUkz0IAQz1cHpUkog0s64nBLa0M8HBumxhWFZl15xBlXR4=='),
      clientSecret: enc('HBumxhWFZl15xBlXR4Q2TuHZCIYUkz0IAQz1cHpUkog0s64nBLa0M8=='),
      sops: {
        age: [
          {
            recipient: 'age13xjamkkjcc2wdan3c8tscslqulgwz9uvxxs532paldqqfn4vxfqq65p0wa',
            enc: '-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSByKy9pQ1k5MmZ2ckpoU2VN\n-----END AGE ENCRYPTED FILE-----\n',
          },
          {
            recipient: 'age1av4gwap6v2pf53acau25l4c8ksmhfu770x4glq7n6uunvq9szvvs3gcpkk',
            enc: '-----BEGIN AGE ENCRYPTED FILE-----\nYWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IFgyNTUxOSBIb0R1cEM2cm9xRERoSG8x\n-----END AGE ENCRYPTED FILE-----\n',
          },
        ],
        lastmodified: '2026-09-11T12:21:01Z',
        mac: enc(
          'YHiQZNpf14sLLLCQfs6+1f1tGAAEMgueJMCRVKIpDptCwE3P0aAjSNenS0mR8upOJX279sxFRfPNZmedpxEiWSZ2EQ==',
        ),
        version: '3.12.1',
      },
      ...over,
    },
    null,
    '\t',
  )

const FILE = 'vault/github-app.sops'

describe('jsonCiphertextError', () => {
  it('accepts a sops JSON file with exactly the three keys', () => {
    expect(jsonCiphertextError(FILE, appFile(), APP)).toBeNull()
  })

  it('refuses sops usage text, which exits 0 too', () => {
    expect(
      jsonCiphertextError(FILE, 'Incorrect Usage: flag provided but not defined: -config', APP),
    ).toMatch(/not produce/)
    expect(jsonCiphertextError(FILE, '[]', APP)).toMatch(/not produce/)
  })

  it('refuses a file missing a key', () => {
    const doc = JSON.parse(appFile()) as Record<string, unknown>
    delete doc.clientSecret
    expect(jsonCiphertextError(FILE, JSON.stringify(doc), APP)).toMatch(/no clientSecret/)
  })

  it('refuses a file with an extra key', () => {
    expect(jsonCiphertextError(FILE, appFile({ appId: enc('abc') }), APP)).toMatch(/unexpected key/)
  })

  it('refuses a key left unencrypted, or encrypted as something other than a string', () => {
    expect(jsonCiphertextError(FILE, appFile({ webhookSecret: 'not-a-secret' }), APP)).toMatch(
      /webhookSecret is not encrypted/,
    )
    expect(jsonCiphertextError(FILE, appFile({ clientSecret: '' }), APP)).toMatch(
      /clientSecret is not encrypted/,
    )
    expect(
      jsonCiphertextError(
        FILE,
        appFile({ pem: 'ENC[AES256_GCM,data:x,iv:y,tag:z,type:int]' }),
        APP,
      ),
    ).toMatch(/pem is not encrypted/)
    expect(jsonCiphertextError(FILE, appFile({ pem: 42 }), APP)).toMatch(/pem is not encrypted/)
  })

  it('refuses a file with no recipient or no MAC', () => {
    expect(jsonCiphertextError(FILE, appFile({ sops: { age: [], mac: enc('m') } }), APP)).toMatch(
      /recipient/,
    )
    expect(jsonCiphertextError(FILE, appFile({ sops: { age: [{}], mac: '' } }), APP)).toMatch(/MAC/)
    expect(jsonCiphertextError(FILE, appFile({ sops: undefined }), APP)).toMatch(/recipient/)
  })

  it('refuses a file that carries any one of the values', () => {
    for (const key of ['webhookSecret', 'clientSecret'] as const) {
      expect(jsonCiphertextError(FILE, appFile({ [key]: APP[key] }), APP)).toMatch(/value itself/)
    }
    expect(jsonCiphertextError(FILE, appFile({ sops: { note: APP.clientSecret } }), APP)).toMatch(
      /value itself/,
    )
  })

  it('refuses a PEM in the output even though JSON escaped its newlines', () => {
    // The whole PEM as a JSON string: no raw newline survives, so only the
    // escaped form or a body line can catch it.
    const out = appFile({ pem: PEM })
    expect(out.includes(PEM)).toBe(false)
    expect(jsonCiphertextError(FILE, out, APP)).toMatch(/value itself/)
  })

  it('refuses every PEM body line of 16 or more characters on its own', () => {
    const lines = PEM.split('\n').filter((l) => l.length >= 16 && !l.startsWith('-----'))
    // Every body line of the fixture, the last one exactly 16: the boundary is in.
    expect(lines).toHaveLength(3)
    expect(lines.at(-1)).toHaveLength(16)
    for (const line of lines) {
      expect(jsonCiphertextError(FILE, appFile({ sops: { note: `x${line}x` } }), APP)).toMatch(
        /value itself/,
      )
    }
  })

  it('does not treat a body line under 16 characters as a leak', () => {
    const short = 'ZWFsbA=='
    const pem = PEM.replace('ZWFsbm90cmVhbA==', short)
    const out = appFile({ sops: { ...JSON.parse(appFile()).sops, note: `x${short}x` } })
    expect(jsonCiphertextError(FILE, out, { ...APP, pem })).toBeNull()
  })

  it('refuses a value spelled in JSON escapes, which the raw output never shows', () => {
    const spelled = (s: string) =>
      [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
    const secret = appFile().replace(
      '"lastmodified"',
      `"note": "${spelled(APP.webhookSecret)}", "lastmodified"`,
    )
    expect(secret.includes(APP.webhookSecret)).toBe(false)
    expect(jsonCiphertextError(FILE, secret, APP)).toMatch(/value itself/)

    const line = PEM.split('\n')[2] ?? ''
    const asKey = appFile().replace('"lastmodified"', `"${spelled(line)}": 1, "lastmodified"`)
    expect(asKey.includes(line)).toBe(false)
    expect(jsonCiphertextError(FILE, asKey, APP)).toMatch(/value itself/)
  })

  it('looks only at the declared keys, and survives a value that is not a string', () => {
    const values = { ...APP, extra: 42, clientSecret: null } as never
    expect(jsonCiphertextError(FILE, appFile(), values)).toBeNull()
  })
})

describe('jsonVaultValuesError', () => {
  it('accepts non-empty strings, and a PEM with or without its one trailing newline', () => {
    expect(PEM.endsWith('-----\n')).toBe(true)
    expect(jsonVaultValuesError(FILE, APP)).toBeNull()
    expect(jsonVaultValuesError(FILE, { ...APP, pem: PEM.slice(0, -1) })).toBeNull()
  })

  it.each([
    [
      'a missing key',
      { pem: PEM, webhookSecret: APP.webhookSecret },
      /clientSecret is not a string/,
    ],
    ['a non-string', { ...APP, clientSecret: 42 }, /clientSecret is not a string/],
    ['a null', { ...APP, pem: null }, /pem is not a string/],
    ['an empty value', { ...APP, webhookSecret: '' }, /webhookSecret is empty/],
    ['a blank value', { ...APP, webhookSecret: '   ' }, /webhookSecret starts or ends/],
    ['a leading space', { ...APP, clientSecret: ` ${APP.clientSecret}` }, /clientSecret starts/],
    ['a trailing newline off a PEM', { ...APP, webhookSecret: `${APP.webhookSecret}\n` }, /starts/],
    ['a PEM with two trailing newlines', { ...APP, pem: `${PEM}\n` }, /pem starts or ends/],
    ['a PEM ending CRLF', { ...APP, pem: `${PEM.slice(0, -1)}\r\n` }, /pem starts or ends/],
    ['a PEM with a leading newline', { ...APP, pem: `\n${PEM}` }, /pem starts or ends/],
    ['a lone newline as the PEM', { ...APP, pem: '\n' }, /pem starts or ends/],
  ])('refuses %s', (_label, values, reason) => {
    const why = jsonVaultValuesError(FILE, values)
    expect(why).toMatch(reason)
    for (const secret of [APP.webhookSecret, APP.clientSecret, PEM.split('\n')[1] ?? '']) {
      expect(why).not.toContain(secret)
    }
  })

  it('refuses no values at all, and ignores keys the file does not declare', () => {
    for (const nothing of [null, undefined, 'pem', 7]) {
      expect(jsonVaultValuesError(FILE, nothing)).toBe('no values were given')
    }
    expect(jsonVaultValuesError(FILE, { ...APP, extra: 42 })).toBeNull()
  })
})
