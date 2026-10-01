import { describe, expect, it } from 'vitest'
import type { ControllerClient } from './controller/client'
import type { RootRunOk as RootRun } from './controller/generated'
import { requestSecretRemove, requestSecretSet, SECRET_PAYLOAD_MAX } from './secret-set'

// What reaches the controller for each action: the verb, its selectors, and
// the sealed document as the payload — or no payload at all.

function fake() {
  const asked: unknown[][] = []
  const client = {
    call: (...args: unknown[]) => {
      asked.push(args)
      return Promise.resolve<RootRun>({
        run: 'r1',
        verb: 'secret-set',
        outcome: 'done',
        detail: 'sealed K',
        verbs: [],
      })
    },
  } as unknown as ControllerClient
  return { client, asked }
}

describe('requestSecretSet', () => {
  it('sends the ciphertext as the payload, the names as selectors', async () => {
    const { client, asked } = fake()
    const doc = '{"data":"ENC[x]","sops":{}}'
    const r = await requestSecretSet(
      { controller: client },
      { actor: 'op@example.test', app: 'hermes', key: 'K', ciphertext: doc },
    )
    expect(r).toEqual({ outcome: 'done', detail: 'sealed K' })
    expect(asked).toEqual([
      [
        'root.run',
        {
          verb: 'secret-set',
          selectors: { app: 'hermes', action: 'set', key: 'K', actor: 'op@example.test' },
          payload: doc,
        },
        { waitMs: 200_000 },
      ],
    ])
  })

  it('refuses a sealed document over the cap without asking', async () => {
    const { client, asked } = fake()
    const r = await requestSecretSet(
      { controller: client },
      { actor: 'a', app: 'hermes', key: 'K', ciphertext: 'x'.repeat(SECRET_PAYLOAD_MAX + 1) },
    )
    expect(r.outcome).toBe('refused')
    expect(asked).toEqual([])
  })
})

describe('requestSecretRemove', () => {
  it('carries no payload, and an actor the pattern takes', async () => {
    const { client, asked } = fake()
    await requestSecretRemove({ controller: client }, { actor: 'José', app: 'hermes', key: 'K' })
    expect(asked).toEqual([
      [
        'root.run',
        {
          verb: 'secret-set',
          selectors: { app: 'hermes', action: 'remove', key: 'K', actor: 'Jos_' },
        },
        { waitMs: 200_000 },
      ],
    ])
  })
})
