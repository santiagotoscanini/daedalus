import { describe, expect, it } from 'vitest'
import type { ControllerClient } from './controller/client'
import { ControllerError, type RootRun } from './controller/wire'
import { rootAnswerText, runRoot } from './root'

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
    expect(await runRoot('deploy', { app: 'blog' }, 1234, client)).toEqual({
      outcome: 'refused',
      detail: 'already running',
    })
    expect(asked).toEqual([['deploy', { app: 'blog' }, 1234]])
  })

  it('reads a call that got no answer as failed, with why', async () => {
    const f = fake(() => Promise.reject(new ControllerError('unreachable', 'no controller')))
    expect(await runRoot('deploy', { app: 'blog' }, 1, f.client)).toEqual({
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
