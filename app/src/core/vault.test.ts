import { describe, expect, it } from 'vitest'
import { sealJsonForVault } from './vault'

// Only the refusals: they return before sops is spawned, so no sops binary is
// needed. A case that got past validation would come back "sops could not run"
// instead, which the reason checks below would catch.

const FILE = 'vault/github-app.sops'

const PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEAtY2ZkZ3hvbm9yZXRlc3RrZXlub3RyZWFsbm90cmVhbG5vdHJl',
  '-----END RSA PRIVATE KEY-----',
  '',
].join('\n')

const GOOD = {
  pem: PEM,
  webhookSecret: 'f3b1c9d27e4a8b6c0d5e2f7a9b3c1d8e6f4a2b0c',
  clientSecret: '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d',
}

describe('sealJsonForVault', () => {
  it.each([
    [
      'a missing key',
      { pem: PEM, webhookSecret: GOOD.webhookSecret },
      /clientSecret is not a string/,
    ],
    ['a non-string value', { ...GOOD, webhookSecret: 7 }, /webhookSecret is not a string/],
    ['an empty value', { ...GOOD, clientSecret: '' }, /clientSecret is empty/],
    ['a padded value', { ...GOOD, clientSecret: `${GOOD.clientSecret}\n` }, /starts or ends/],
    ['a PEM with a second newline', { ...GOOD, pem: `${PEM}\n` }, /pem starts or ends/],
  ])('refuses %s before sops runs', async (_label, values, reason) => {
    const sealed = await sealJsonForVault(FILE, values as never)
    expect(sealed.ok).toBe(false)
    const said = sealed.ok ? '' : sealed.reason
    expect(said).toMatch(reason)
    expect(said).toMatch(/^Nothing was sent: /)
    expect(said).not.toContain(GOOD.clientSecret)
  })

  it('never throws, whatever it is handed', async () => {
    for (const values of [null, undefined, 'pem', 42, []]) {
      await expect(sealJsonForVault(FILE, values as never)).resolves.toMatchObject({ ok: false })
    }
    await expect(sealJsonForVault('vault/nope.sops' as never, GOOD)).resolves.toEqual({
      ok: false,
      reason: 'Nothing was sent: the file is not a JSON vault entry.',
    })
  })
})
