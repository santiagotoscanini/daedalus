import { describe, expect, it } from 'vitest'
import type { ControllerClient } from './controller/client'
import { ControllerError, type RootRun } from './controller/wire'
import { requestReboot } from './power'

// The restart against a fake controller: what it asks for, and how each of the
// helper's answers — and the connection ending — reads to the page.

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
  verb: 'reboot',
  outcome,
  detail,
  verbs: [],
})

describe('requestReboot', () => {
  it('asks the root helper for reboot, with no selectors, and waits past its 90 s', async () => {
    const { client, asked } = fake(() => Promise.resolve(run('done', 'rebooting')))
    expect(await requestReboot({ actor: 'alice' }, client)).toEqual({
      state: 'rebooting',
      detail: 'rebooting',
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.[0]).toBe('reboot')
    expect(asked[0]?.[1]).toEqual({})
    expect(asked[0]?.[2]).toBeGreaterThan(90_000)
  })

  it("carries the unit's refusal, and a failure, as the reason", async () => {
    const refused = fake(() => Promise.resolve(run('refused', 'an apply is running')))
    expect(await requestReboot({ actor: 'a' }, refused.client)).toEqual({
      state: 'refused',
      reason: 'an apply is running',
    })
    const failed = fake(() => Promise.resolve(run('failed', '')))
    expect(await requestReboot({ actor: 'a' }, failed.client)).toEqual({
      state: 'refused',
      reason: 'the restart failed',
    })
  })

  it('reads a connection that closed mid-call as the box going down, and anything else as a refusal', async () => {
    const closed = fake(() => Promise.reject(new ControllerError('closed', 'gone')))
    expect((await requestReboot({ actor: 'a' }, closed.client)).state).toBe('rebooting')
    for (const code of ['unreachable', 'unsupported', 'timeout', 'unavailable'] as const) {
      const f = fake(() => Promise.reject(new ControllerError(code, `said ${code}`)))
      expect(await requestReboot({ actor: 'a' }, f.client)).toEqual({
        state: 'refused',
        reason: `said ${code}`,
      })
    }
  })
})
