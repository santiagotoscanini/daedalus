import { describe, expect, it } from 'vitest'
import { followRequest, type VerbOutcome } from './follow-request'

const answers = (...xs: (VerbOutcome | null | Error)[]) => {
  let i = 0
  return async () => {
    const x = xs[Math.min(i++, xs.length - 1)] ?? null
    if (x instanceof Error) throw x
    return x
  }
}

describe('followRequest', () => {
  it('waits through "not listed yet", a failed read and running, and returns the ending', async () => {
    const seen: string[] = []
    const o = await followRequest(
      answers(
        null,
        new Error('blip'),
        { state: 'running', detail: 'loading' },
        {
          state: 'done',
          detail: 'loaded',
        },
      ),
      { waitMs: 1_000, intervalMs: 1, onProgress: (p) => seen.push(p.detail) },
    )
    expect(o).toEqual({ state: 'done', detail: 'loaded' })
    expect(seen).toEqual(['loading'])
  })

  it('carries a refusal as the ending', async () => {
    const o = await followRequest(answers({ state: 'refused', detail: 'no such model' }), {
      waitMs: 1_000,
      intervalMs: 1,
    })
    expect(o.state).toBe('refused')
  })

  it('gives up after the wait, saying the machine may still finish', async () => {
    const o = await followRequest(answers(null), { waitMs: 20, intervalMs: 5 })
    expect(o.state).toBe('failed')
    expect(o.detail).toMatch(/may still finish/)
  })
})
