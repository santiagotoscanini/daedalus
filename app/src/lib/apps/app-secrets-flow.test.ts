import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../core/ctx'

// The write half of the app-secrets editor, asserted over WHAT REACHED THE
// HOST rather than over what was returned.
//
// That distinction is the whole point of this file. A request asked of the
// root helper's `secret-set` verb reaches a root-side agent
// (nix/stacks/daedalus, host/secret-set.sh) which decrypts it and rewrites a
// committed file. So a refusal that still asked, or a request carrying a
// plaintext, is a real fault that a test of the return value alone would pass
// straight over. `h.requested` being empty IS the assertion for every refusal
// here.
//
// The allowlist mocked below stands in for the applied registry. It is the
// same set nix generates SECRET_APPS from, and the host checks it again — this
// side exists so a refusal is a sentence on the page instead of a failed unit.

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  /** The apps the applied registry knows about. */
  apps: ['hermes'] as string[],
  /** Everything that reached the host. Empty is the assertion for a refusal. */
  requested: [] as Row[],
  /** Everything handed to sops. Empty means nothing was even sealed. */
  sealed: [] as Row[],
  sealFails: null as string | null,
}))

vi.mock('../../host/nix-manifest', () => ({
  readNixManifest: async () => ({
    registry: { apps: Object.fromEntries(h.apps.map((a) => [a, {}])) },
  }),
}))

vi.mock('../../host/secret-set', () => ({
  requestSecretSet: async (_ctx: unknown, body: Row) => {
    h.requested.push({ verb: 'set', ...body })
    return { outcome: 'done', detail: 'sealed' }
  },
  requestSecretRemove: async (_ctx: unknown, body: Row) => {
    h.requested.push({ verb: 'remove', ...body })
    return { outcome: 'done', detail: 'removed' }
  },
}))

vi.mock('../../core/vault', () => ({
  sealAppSecret: async (app: string, value: string) => {
    h.sealed.push({ app, value })
    return h.sealFails === null
      ? { ok: true, value: '{"data":"ENC[sealed]","sops":{}}' }
      : { ok: false, reason: h.sealFails }
  },
}))

const { removeAppSecret, setAppSecret } = await import('./secrets')

const CTX = {} as Pick<Ctx, 'controller'>

beforeEach(() => {
  h.apps = ['hermes']
  h.requested = []
  h.sealed = []
  h.sealFails = null
})

describe('setAppSecret', () => {
  it('seals the value and sends the CIPHERTEXT, never the value', async () => {
    const r = await setAppSecret(CTX, {
      name: 'hermes',
      key: 'INVITE_CODE',
      value: 'hunter2',
      actor: 'someone@example.com',
    })

    expect(r).toEqual({ outcome: 'done', detail: 'sealed' })
    expect(h.requested).toEqual([
      {
        verb: 'set',
        app: 'hermes',
        key: 'INVITE_CODE',
        ciphertext: '{"data":"ENC[sealed]","sops":{}}',
        actor: 'someone@example.com',
      },
    ])
    // The controller, the helper and the run file only ever hold ciphertext.
    expect(JSON.stringify(h.requested)).not.toContain('hunter2')
  })

  it('refuses a key that is not an environment variable name, and seals nothing', async () => {
    for (const key of ['HAS-HYPHEN', '9LEADING', 'sops_mac', '']) {
      const r = await setAppSecret(CTX, { name: 'hermes', key, value: 'v', actor: 'a' })
      expect(r.outcome, key).toBe('refused')
    }
    expect(h.sealed).toEqual([])
    expect(h.requested).toEqual([])
  })

  it('refuses an app the applied registry does not name, and seals nothing', async () => {
    // The host has no writable path for such a name — nix builds SECRET_APPS
    // from the same committed registry — so this refusal is the readable
    // version of what would otherwise be a rejected request a second later.
    const r = await setAppSecret(CTX, { name: 'ghost', key: 'TOKEN', value: 'v', actor: 'a' })
    expect(r).toEqual({
      outcome: 'refused',
      detail:
        'ghost is not in the applied registry, so this box has no secrets file for it yet. Apply first.',
    })
    expect(h.sealed).toEqual([])
    expect(h.requested).toEqual([])
  })

  it('checks the key BEFORE the app, so a bad name never leaks which apps exist', async () => {
    const r = await setAppSecret(CTX, { name: 'ghost', key: 'HAS-HYPHEN', value: 'v', actor: 'a' })
    expect(r.outcome).toBe('refused')
    expect(r.detail).not.toContain('ghost')
  })

  it('asks nothing when sealing fails', async () => {
    // The container's own last check on what sops produced (core/vault.ts). A
    // request asked anyway would ask the host to decrypt something that is
    // not a sops file.
    h.sealFails = 'Nothing was sent: the value is not encrypted.'
    const r = await setAppSecret(CTX, { name: 'hermes', key: 'TOKEN', value: 'v', actor: 'a' })
    expect(r).toEqual({
      outcome: 'refused',
      detail: 'Nothing was sent: the value is not encrypted.',
    })
    expect(h.requested).toEqual([])
  })
})

describe('removeAppSecret', () => {
  it('sends the app, the key and the actor — and nothing else', async () => {
    const r = await removeAppSecret(CTX, { name: 'hermes', key: 'INVITE_CODE', actor: 'op' })
    expect(r).toEqual({ outcome: 'done', detail: 'removed' })
    // No ciphertext: there is no value to send, and this is the one verb here
    // that needs no sops on this side at all.
    expect(h.requested).toEqual([
      { verb: 'remove', app: 'hermes', key: 'INVITE_CODE', actor: 'op' },
    ])
    expect(h.sealed).toEqual([])
  })

  it('refuses an unknown app and a bad key, asking nothing either way', async () => {
    expect((await removeAppSecret(CTX, { name: 'ghost', key: 'TOKEN', actor: 'op' })).outcome).toBe(
      'refused',
    )
    expect((await removeAppSecret(CTX, { name: 'hermes', key: '../x', actor: 'op' })).outcome).toBe(
      'refused',
    )
    expect(h.requested).toEqual([])
  })
})
