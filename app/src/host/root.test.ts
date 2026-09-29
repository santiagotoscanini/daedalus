import { describe, expect, it } from 'vitest'
import type { ControllerClient } from './controller/client'
import { ControllerError, type RootRun } from './controller/wire'
import { rootActor, rootAnswerText, runRoot } from './root'

// runRoot against a fake controller: what it asks, and how each answer — and
// a call that never got one — reads.

function fake(answer: () => Promise<RootRun>) {
  const asked: unknown[][] = []
  const client = {
    rootRun: (...args: unknown[]) => {
      asked.push(args)
      return answer()
    },
  } as unknown as ControllerClient
  return { client, asked }
}

const run = (outcome: RootRun['outcome'], detail: string): RootRun => ({
  run: 'r1',
  verb: 'deploy',
  outcome,
  detail,
  verbs: [],
})

describe('runRoot', () => {
  it('asks for the verb with its selectors and wait, and carries the answer', async () => {
    const { client, asked } = fake(() => Promise.resolve(run('refused', 'already running')))
    expect(await runRoot({ controller: client }, 'deploy', { app: 'blog' }, 1234)).toEqual({
      outcome: 'refused',
      detail: 'already running',
    })
    expect(asked).toEqual([['deploy', { app: 'blog' }, 1234, undefined]])
  })

  it('hands a payload on beside the selectors', async () => {
    const { client, asked } = fake(() => Promise.resolve(run('done', 'sealed')))
    await runRoot({ controller: client }, 'secret-set', { app: 'blog' }, 5, '{"data":"ENC[x]"}')
    expect(asked).toEqual([['secret-set', { app: 'blog' }, 5, '{"data":"ENC[x]"}']])
  })

  it('reads a call that got no answer as failed, with why', async () => {
    const f = fake(() => Promise.reject(new ControllerError('unreachable', 'no controller')))
    expect(await runRoot({ controller: f.client }, 'deploy', { app: 'blog' }, 1)).toEqual({
      outcome: 'failed',
      detail: 'no controller',
    })
  })

  it('says the outcome when the unit said nothing', () => {
    expect(rootAnswerText({ outcome: 'failed', detail: '' }, 'the deploy')).toBe(
      'the deploy failed',
    )
    expect(rootAnswerText({ outcome: 'done', detail: 'deployed' }, 'the deploy')).toBe('deployed')
  })
})

describe('rootActor', () => {
  it('keeps a label the actor pattern takes', () => {
    for (const ok of ['op@example.test', 'api', 'first.last+tag@example.org', 'A B']) {
      expect(rootActor(ok)).toBe(ok)
    }
  })

  it('maps what the pattern refuses to `_`, and nothing to unknown', () => {
    expect(rootActor('op\n@x')).toBe('op_@x')
    expect(rootActor('José')).toBe('Jos_')
    expect(rootActor('-rf')).toBe('_rf')
    expect(rootActor('')).toBe('unknown')
    expect(rootActor('   ')).toBe('unknown')
    expect(rootActor('x'.repeat(300))).toHaveLength(128)
  })
})
