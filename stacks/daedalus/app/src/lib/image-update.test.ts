import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readImageUpdateStatus } from './image-update'

// The one rule in this module that is not a straight file read: a `running`
// status that has stopped being refreshed is a corpse, and must not be
// reported as a live run.
//
// This is not hypothetical. The first real update this bridge ever performed
// was SIGTERMed mid-switch by its own rebuild, and left `running switching` in
// the file with nothing on the box that would ever clear it. Because the flow
// refuses to start while a run is in flight, that single file would have
// disabled every Update button until the container was restarted.

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'imgupd-'))
  process.env.APPLY_DIR = dir
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  process.env.APPLY_DIR = undefined
})

/** `finishedAt` is rewritten at every phase, so it is really "last written". */
const status = (state: string, minutesAgo: number, phase = 'switching') =>
  writeFile(
    join(dir, 'image-status.json'),
    JSON.stringify({
      id: 'abc',
      container: 'intel-gpu-exporter',
      state,
      phase,
      error: '',
      moves: [],
      startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      finishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      commit: '',
    }),
  )

describe('a run that stopped writing is reported as failed', () => {
  it('a fresh running status is left alone', async () => {
    await status('running', 2)
    const s = await readImageUpdateStatus()
    expect(s.state).toBe('running')
    expect(s.phase).toBe('switching')
    expect(s.error).toBe('')
  })

  // The unit's own TimeoutStartSec is 30 minutes, so a switch still going at
  // 29 is slow rather than dead — and declaring it dead would let a second
  // rebuild start against a flake the first one is mid-way through changing.
  it('a slow-but-live run inside the unit timeout is left alone', async () => {
    await status('running', 29)
    expect((await readImageUpdateStatus()).state).toBe('running')
  })

  it('a running status past the unit timeout becomes failed', async () => {
    await status('running', 40)
    const s = await readImageUpdateStatus()
    expect(s.state).toBe('failed')
    // The phase is kept: which step it died on is the whole diagnostic value.
    expect(s.phase).toBe('switching')
    expect(s.error).toMatch(/stopped writing during "switching"/)
    // It must NOT claim the rebuild failed — it genuinely does not know. The
    // real incident had already committed, switched and pulled the new image.
    expect(s.error).toMatch(/may or may not have completed/)
  })

  it('terminal states are never rewritten, however old', async () => {
    for (const state of ['done', 'failed', 'idle']) {
      await status(state, 500)
      expect((await readImageUpdateStatus()).state).toBe(state)
    }
  })

  it('no status file at all is idle, not a dead run', async () => {
    const s = await readImageUpdateStatus()
    expect(s.state).toBe('idle')
    expect(s.id).toBeNull()
  })
})
