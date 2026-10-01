import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RootAnswer } from '../../host/root'
import { ENGINE_VERDICTS } from '../../lib/build-queue'
import { type BuildState, TERMINAL_BUILD_STATES } from '../../lib/builds'
import type { Ctx } from '../ctx'
import { cancelBuild } from './actions'

// Cancel asks the host first and writes after. The race it exists for: the
// stop takes seconds, and while it is being answered the scheduler's tick
// folds whatever the host publishes. A row written `cancelled` before asking
// was terminal and no engine verdict, so a build that SUCCEEDED in that window
// could never get its ending back, and a stop the host REFUSED left a cancelled
// row over a build that may still run.
//
// The row here follows the repository's rules: `updateFromStatus` (the tick's
// fold) refuses a final row unless the host overturns an engine verdict, and
// `markCancelled` takes an open row or the reaper's `failed: interrupted`
// (lib/repo/builds.test.ts pins that SQL).

type Row = { id: string; app: string; sha: string; state: BuildState; error: string | null }

const h = vi.hoisted(() => ({
  row: null as null | {
    id: string
    app: string
    sha: string
    state: string
    error: string | null
  },
  /** What the host does while the stop is answered, then its answer. */
  host: async (): Promise<{ outcome: 'done' | 'refused' | 'failed'; detail: string }> => ({
    outcome: 'done',
    detail: 'stopped',
  }),
  asked: 0,
}))

const ID = '0b6f3c1e-8a2d-4e5f-9c7b-1d2e3f4a5b6c'
const isFinal = (s: string) => (TERMINAL_BUILD_STATES as readonly string[]).includes(s)

/** The tick's fold of a host status: the repository's rule, on the one row. */
function fold(state: BuildState, error: string | null) {
  const r = h.row
  if (r === null) return
  const verdict = r.state === 'failed' && r.error !== null && ENGINE_VERDICTS.includes(r.error)
  if (isFinal(r.state) && !verdict) return
  r.state = state
  r.error = error
}

vi.mock('../../lib/repo/builds', () => ({
  getBuild: async (id: string) => (h.row?.id === id ? { ...h.row } : undefined),
  markCancelled: async (id: string) => {
    const r = h.row
    if (r === null || r.id !== id) return undefined
    const open = !isFinal(r.state)
    if (!open && !(r.state === 'failed' && r.error === 'interrupted')) return undefined
    r.state = 'cancelled'
    r.error = 'cancelled by the operator'
    return { ...r }
  },
}))

vi.mock('../../host/build-verb', () => ({
  requestBuildCancel: async (): Promise<RootAnswer> => {
    h.asked += 1
    return h.host()
  },
}))

const ctx = {} as Pick<Ctx, 'controller'>
const cancel = () => cancelBuild(ctx, { app: 'iris', id: ID, actor: 'santiago' })

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  h.asked = 0
  h.row = { id: ID, app: 'iris', sha: 'a'.repeat(40), state: 'building', error: null } satisfies Row
  h.host = async () => ({ outcome: 'done', detail: 'stopped' })
})

describe('cancelBuild', () => {
  it('marks the row cancelled once the host has stopped the build', async () => {
    expect(await cancel()).toEqual({ ok: true, value: null })
    expect(h.row).toMatchObject({ state: 'cancelled', error: 'cancelled by the operator' })
  })

  it('takes over the interrupted the reaper published for that stop, folded meanwhile', async () => {
    h.host = async () => {
      fold('failed', 'interrupted')
      return { outcome: 'done', detail: 'stopped' }
    }
    expect(await cancel()).toEqual({ ok: true, value: null })
    expect(h.row).toMatchObject({ state: 'cancelled', error: 'cancelled by the operator' })
  })

  it('keeps a success the host published while the stop was being answered', async () => {
    h.host = async () => {
      fold('succeeded', null)
      return { outcome: 'done', detail: 'stopped' }
    }
    const result = await cancel()
    expect(result.ok).toBe(false)
    expect(h.row).toMatchObject({ state: 'succeeded', error: null })
  })

  it('returns a refusal with the host’s words and leaves the row to the host', async () => {
    h.host = async () => ({ outcome: 'refused', detail: 'iris has no build in flight' })
    expect(await cancel()).toEqual({
      ok: false,
      reason: 'The host did not stop the build: iris has no build in flight',
    })
    expect(h.row).toMatchObject({ state: 'building', error: null })
    // ...so the host's own ending still lands.
    fold('succeeded', null)
    expect(h.row?.state).toBe('succeeded')
  })

  it('reports a host it could not ask, and writes nothing', async () => {
    h.host = async () => ({ outcome: 'failed', detail: 'no socket' })
    expect(await cancel()).toEqual({
      ok: false,
      reason: 'The host did not stop the build: no socket',
    })
    expect(h.row?.state).toBe('building')
  })

  it('does not ask the host about a build that is already final or still queued', async () => {
    if (h.row) h.row.state = 'succeeded'
    expect(await cancel()).toEqual({ ok: true, value: null })
    if (h.row) h.row.state = 'queued'
    expect((await cancel()).ok).toBe(false)
    expect(h.asked).toBe(0)
  })
})
