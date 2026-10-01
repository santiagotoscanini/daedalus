import { describe, expect, it } from 'vitest'
import { defineFlow, defineGate, type FlowPlan } from './flow'

// host/apply-flow.test.ts, update-flow.test.ts and engine-flow.test.ts prove
// the lock through a fake controller. What they cannot show is the
// skeleton's own contract — the ORDER of the steps, and that two flows on one
// gate take turns — since each of them has exactly one arrangement of it. The
// status and the start are fakes here for that reason: `started` is the list
// of runs that reached the root helper, and a refusal is only a refusal if it
// is not on it. The helper refuses a second run while one is under way: the
// fake start does too, once `running` says so.

type Status = { id: string | null; state: string; phase: string }

function harness(initial: Status = { id: null, state: 'idle', phase: '' }) {
  const box = { status: initial, started: [] as string[], prepared: 0 }
  const gate = defineGate<string, Status>({
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
        if (box.started.length > 0) {
          return { ok: false, code: 'busy', reason: 'daedalus-apply@id-1 is still running' }
        }
        const id = `id-${String(box.started.length + 1)}`
        box.started.push(id)
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
    expect(box.started).toEqual([])
  })

  it('reports the id beside the plan’s own fields', async () => {
    const { run } = harness()
    expect(await run('iris')).toEqual({ ok: true, id: 'id-1', name: 'iris' })
  })
})

describe('a refusal', () => {
  it('from prepare starts nothing', async () => {
    const { run, box } = harness()
    expect(await run('nothing')).toEqual({ ok: false, code: 'noop', reason: 'nothing to apply' })
    expect(box.started).toEqual([])
    expect(await run('iris')).toMatchObject({ ok: true })
  })

  it('from the start is the answer', async () => {
    const { run } = harness()
    expect(await run('one')).toMatchObject({ ok: true, id: 'id-1' })
    expect(await run('two')).toEqual({
      ok: false,
      code: 'busy',
      reason: 'daedalus-apply@id-1 is still running',
    })
  })
})

describe('two flows on one gate', () => {
  // Apply's arrangement: runApply and runSecretApply start the same verb, so
  // whichever starts first is what the other is refused by.
  it('take turns, and only one of two concurrent callers starts', async () => {
    const { gate, run, plan, box } = harness()
    const other = defineFlow<string, { name: string }, 'noop' | 'malformed'>(gate, {
      prepare: plan,
    })

    const outcomes = await Promise.all([run('one'), other('two')])
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(1)
    expect(box.started).toEqual(['id-1'])
  })

  it('keeps serving after a flow throws', async () => {
    const { gate, run } = harness()
    const broken = defineFlow<string, { name: string }>(gate, {
      prepare: async () => {
        throw new Error('the start could not be asked')
      },
    })
    await expect(broken('x')).rejects.toThrow('the start could not be asked')
    expect(await run('iris')).toMatchObject({ ok: true })
  })
})

describe('blocked', () => {
  it('answers the gate’s question without taking the lock or starting anything', async () => {
    const { gate, box } = harness({ id: 'abc', state: 'running', phase: 'building' })
    expect(await gate.blocked('x')).toEqual({
      ok: false,
      code: 'busy',
      reason: 'an apply is already running (building)',
    })
    box.status = { id: 'abc', state: 'done', phase: 'complete' }
    expect(await gate.blocked('x')).toBeNull()
    expect(box.started).toEqual([])
  })
})
