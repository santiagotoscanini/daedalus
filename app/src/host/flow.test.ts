import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineFlow, defineGate, type FlowPlan, PICKUP_MS } from './flow'

// host/apply-flow.test.ts, update-flow.test.ts and engine-flow.test.ts prove
// the lock through a real bridge. What they cannot show is the skeleton's own
// contract — the ORDER of the steps, and that two flows on one gate refuse
// each other — since each of them has exactly one arrangement of it. The status and the write are
// fakes here for that reason: `published` is the list of requests that reached
// the bridge, and a refusal is only a refusal if it is not on it.

type Status = { id: string | null; state: string; phase: string }

function harness(initial: Status = { id: null, state: 'idle', phase: '' }) {
  const box = { status: initial, published: [] as string[], prepared: 0 }
  const gate = defineGate<Status>({
    noun: 'apply',
    readStatus: async () => box.status,
    running: (s) => `an apply is already running (${s.phase})`,
  })
  const plan = async (name: string): Promise<FlowPlan<{ name: string }, 'noop' | 'malformed'>> => {
    box.prepared += 1
    if (name === 'nothing') return { ok: false, code: 'noop', reason: 'nothing to apply' }
    return {
      ok: true,
      value: { name },
      publish: async () => {
        const id = `id-${String(box.published.length + 1)}`
        box.published.push(id)
        return id
      },
    }
  }
  const run = defineFlow<string, { name: string }, 'noop' | 'malformed'>(gate, {
    check: (name) =>
      name === '' ? { ok: false, code: 'malformed', reason: 'no name given' } : null,
    prepare: plan,
  })
  return { box, gate, run, plan }
}

const NOT_PICKED_UP = {
  ok: false,
  code: 'busy',
  reason: 'the previous apply request has not been picked up by the host yet',
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the order of the steps', () => {
  it('refuses a malformed input as malformed even while the host is running', async () => {
    const { run, box } = harness({ id: 'abc', state: 'running', phase: 'rebuilding' })
    expect(await run('')).toEqual({ ok: false, code: 'malformed', reason: 'no name given' })
    expect(box.prepared).toBe(0)
  })

  it('prepares nothing for a request it is about to refuse as busy', async () => {
    const { run, box } = harness({ id: 'abc', state: 'running', phase: 'rebuilding' })
    expect(await run('iris')).toEqual({
      ok: false,
      code: 'busy',
      reason: 'an apply is already running (rebuilding)',
    })
    expect(box.prepared).toBe(0)
    expect(box.published).toEqual([])
  })

  it('reports the id beside the plan’s own fields', async () => {
    const { run } = harness()
    expect(await run('iris')).toEqual({ ok: true, id: 'id-1', name: 'iris' })
  })
})

describe('a refusal from prepare', () => {
  it('publishes nothing and opens no pickup window', async () => {
    const { run, box } = harness()
    expect(await run('nothing')).toEqual({ ok: false, code: 'noop', reason: 'nothing to apply' })
    expect(box.published).toEqual([])
    expect(await run('iris')).toMatchObject({ ok: true })
  })
})

describe('the pickup window', () => {
  it('refuses inside it, clears after it, and ends early on the host’s acknowledgement', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { run, box } = harness()

    expect(await run('one')).toMatchObject({ ok: true, id: 'id-1' })
    vi.setSystemTime(Date.now() + PICKUP_MS - 1_000)
    expect(await run('two')).toEqual(NOT_PICKED_UP)

    vi.setSystemTime(Date.now() + 2_000)
    expect(await run('two')).toMatchObject({ ok: true, id: 'id-2' })

    expect(await run('three')).toEqual(NOT_PICKED_UP)
    box.status = { id: 'id-2', state: 'done', phase: 'done' }
    expect(await run('three')).toMatchObject({ ok: true, id: 'id-3' })
  })
})

describe('two flows on one gate', () => {
  // Apply's arrangement: runApply and runSecretApply write the same request
  // file, so whichever publishes first must be what the other is refused by.
  it('refuse each other, and only one of two concurrent callers publishes', async () => {
    const { gate, run, plan, box } = harness()
    const other = defineFlow<string, { name: string }, 'noop' | 'malformed'>(gate, {
      prepare: plan,
    })

    const outcomes = await Promise.all([run('one'), other('two')])
    expect(outcomes.filter((o) => !o.ok)).toEqual([NOT_PICKED_UP])
    expect(box.published).toEqual(['id-1'])
  })

  it('keeps serving after a flow throws', async () => {
    const { gate, run } = harness()
    const broken = defineFlow<string, { name: string }>(gate, {
      prepare: async () => {
        throw new Error('the bridge would not take the write')
      },
    })
    await expect(broken('x')).rejects.toThrow('the bridge would not take the write')
    expect(await run('iris')).toMatchObject({ ok: true })
  })
})

describe('blocked', () => {
  it('answers the gate’s question without taking the lock or publishing', async () => {
    const { gate, run, box } = harness()
    expect(await gate.blocked()).toBeNull()
    await run('iris')
    expect(await gate.blocked()).toEqual(NOT_PICKED_UP)
    expect(box.published).toEqual(['id-1'])
  })
})
