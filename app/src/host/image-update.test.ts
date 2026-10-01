import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../core/ctx'
import { readImageUpdateStatus, startImageUpdate } from './image-update'

// A `running` status is believed only while its run is: the controller's run
// store says whether the run has ended, and when the controller has forgotten
// it, the helper's `status` says whether the verb's unit runs at all. A run
// that ended without its last status — the box went down mid-run — is
// reported as failed, because the flow refuses to start while one is in
// flight and a stuck file would disable every Update button. No clock.

const h = vi.hoisted(() => ({
  follow: null as unknown,
  status: null as unknown,
  started: [] as unknown[][],
  start: null as unknown,
}))

const ctx = {
  controller: {
    rootFollow: async () => {
      if (h.follow instanceof Error) throw h.follow
      return h.follow
    },
    rootRun: async () => {
      if (h.status instanceof Error) throw h.status
      return h.status
    },
    rootStart: async (...args: unknown[]) => {
      h.started.push(args)
      if (h.start instanceof Error) throw h.start
      return h.start
    },
  },
} as unknown as Pick<Ctx, 'controller'>

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgupd-'))
  process.env.VERBS_DIR = dir
  h.follow = { run: { outcome: null, detail: '' } }
  h.status = { verbs: [{ verb: 'image-update', activeState: 'activating' }] }
  h.started = []
  h.start = { run: 'r1', verb: 'image-update', outcome: null, detail: '', verbs: [] }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  delete process.env.VERBS_DIR
})

const status = (state: string, phase = 'switching') =>
  writeFile(
    join(dir, 'image-update-status.json'),
    JSON.stringify({
      id: 'a1b2c3d4e5f60718',
      targets: ['intel-gpu-exporter'],
      state,
      phase,
      error: '',
      moves: [],
      startedAt: '2026-10-01T10:00:00Z',
      finishedAt: '2026-10-01T10:00:00Z',
      commit: '',
    }),
  )

const notFound = Object.assign(new Error('no run'), { code: 'not_found' })

describe('a running status', () => {
  it('is left alone while its run goes on, however old the file', async () => {
    await status('running')
    const s = await readImageUpdateStatus(ctx)
    expect(s.state).toBe('running')
    expect(s.error).toBe('')
  })

  it('becomes failed once its run has ended, keeping the phase it died in', async () => {
    await status('running')
    h.follow = { run: { outcome: 'failed', detail: 'the unit failed (Result=signal)' } }
    const s = await readImageUpdateStatus(ctx)
    expect(s.state).toBe('failed')
    expect(s.phase).toBe('switching')
    expect(s.error).toMatch(/ended during "switching"/)
    // It must NOT claim the rebuild failed — it genuinely does not know.
    expect(s.error).toMatch(/may or may not have completed/)
    expect(s.error).toMatch(/\(the unit failed \(Result=signal\)\)$/)
  })

  it('asks the helper when the controller has forgotten the run', async () => {
    await status('running')
    h.follow = notFound
    expect((await readImageUpdateStatus(ctx)).state).toBe('running')
    h.status = { verbs: [{ verb: 'image-update', activeState: 'inactive' }] }
    expect((await readImageUpdateStatus(ctx)).state).toBe('failed')
  })

  it('is believed when neither can answer', async () => {
    await status('running')
    h.follow = notFound
    h.status = new Error('the controller did not answer')
    expect((await readImageUpdateStatus(ctx)).state).toBe('running')
  })
})

describe('the other states', () => {
  it('are never rewritten', async () => {
    h.follow = { run: { outcome: 'failed', detail: '' } }
    for (const state of ['done', 'failed', 'idle']) {
      await status(state)
      expect((await readImageUpdateStatus(ctx)).state).toBe(state)
    }
  })

  it('no status file at all is idle, not a dead run', async () => {
    const s = await readImageUpdateStatus(ctx)
    expect(s.state).toBe('idle')
    expect(s.id).toBeNull()
  })
})

describe('startImageUpdate', () => {
  it('asks the helper’s image-update, detached, the targets as the payload', async () => {
    expect(
      await startImageUpdate(ctx, {
        targets: [{ container: 'iris' }, { container: 'pg', toTag: '18' }],
        actor: 'santiago',
      }),
    ).toEqual({ ok: true, id: 'r1' })
    expect(h.started[0]?.slice(0, 2)).toEqual(['image-update', {}])
    expect(JSON.parse(String(h.started[0]?.[2]))).toEqual({
      targets: [{ container: 'iris' }, { container: 'pg', toTag: '18' }],
      actor: 'santiago',
    })
  })

  it('carries the helper’s refusal as busy, and no controller as unavailable', async () => {
    h.start = {
      run: 'r2',
      verb: 'image-update',
      outcome: 'refused',
      detail: 'daedalus-image-update@r1 is still running; wait for it to finish',
      verbs: [],
    }
    expect(await startImageUpdate(ctx, { targets: [{ container: 'iris' }], actor: 'a' })).toEqual({
      ok: false,
      code: 'busy',
      reason: 'daedalus-image-update@r1 is still running; wait for it to finish',
    })
    h.start = new Error('no socket at /controller/api.sock')
    expect(await startImageUpdate(ctx, { targets: [{ container: 'iris' }], actor: 'a' })).toEqual({
      ok: false,
      code: 'unavailable',
      reason: 'no socket at /controller/api.sock',
    })
  })
})
