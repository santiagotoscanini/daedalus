import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readEngineUpdateStatus } from './engine-update'

// The one rule in this module that is not a straight file read — the same
// one host/image-update.ts carries, for the same incident: a `running`
// status that has stopped being refreshed is a corpse, and reporting it as
// live would disable the button until a container restart.

let dir: string
let previous: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engupd-'))
  previous = process.env.APPLY_DIR
  process.env.APPLY_DIR = dir
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.APPLY_DIR
  else process.env.APPLY_DIR = previous
})

const status = (state: string, minutesAgo: number, phase = 'switching') =>
  writeFile(
    join(dir, 'engine-status.json'),
    JSON.stringify({
      id: 'abc',
      state,
      phase,
      error: '',
      from: 'aaaa',
      to: 'bbbb',
      startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      finishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      commit: '',
    }),
  )

describe('a run that stopped writing is reported as failed', () => {
  it('a fresh running status is left alone, revs included', async () => {
    await status('running', 2)
    const s = await readEngineUpdateStatus()
    expect(s.state).toBe('running')
    expect(s.from).toBe('aaaa')
    expect(s.to).toBe('bbbb')
  })

  // Either side of RUNNING_MAX_MS, which follows the unit's TimeoutStartSec.
  it('a slow-but-live run inside the unit timeout is left alone', async () => {
    await status('running', 59)
    expect((await readEngineUpdateStatus()).state).toBe('running')
  })

  it('a running status past the unit timeout becomes failed, phase kept', async () => {
    await status('running', 70)
    const s = await readEngineUpdateStatus()
    expect(s.state).toBe('failed')
    expect(s.phase).toBe('switching')
    expect(s.error).toMatch(/stopped writing during "switching"/)
    expect(s.error).toMatch(/daedalus-engine-update/)
  })

  it('terminal states are never rewritten, and no file is idle', async () => {
    for (const state of ['done', 'failed', 'idle']) {
      await status(state, 500)
      expect((await readEngineUpdateStatus()).state).toBe(state)
    }
    await rm(join(dir, 'engine-status.json'))
    const s = await readEngineUpdateStatus()
    expect(s.state).toBe('idle')
    expect(s.id).toBeNull()
    expect(s.from).toBe('')
  })
})
