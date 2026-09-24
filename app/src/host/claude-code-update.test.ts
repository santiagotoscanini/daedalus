import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readClaudeCodeUpdateStatus } from './claude-code-update'

// The staleness rule, as host/engine-update.ts carries it — but against a
// far shorter clock, because this verb does not build: three small fetches,
// a signature check and a push. The window here follows its own unit's
// TimeoutStartSec (10 minutes, stacks/daedalus/claude-code-update.nix), not
// the engine's hour, and a test that passes for both numbers would not be
// testing the one that matters.

let dir: string
let previous: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ccupd-'))
  previous = process.env.APPLY_DIR
  process.env.APPLY_DIR = dir
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  if (previous === undefined) delete process.env.APPLY_DIR
  else process.env.APPLY_DIR = previous
})

const status = (state: string, minutesAgo: number, phase = 'committing') =>
  writeFile(
    join(dir, 'claude-code-status.json'),
    JSON.stringify({
      id: 'abc',
      state,
      phase,
      error: '',
      from: '2.1.259',
      to: '2.1.281',
      startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      finishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      commit: '',
    }),
  )

describe('a pin that stopped writing is reported as failed', () => {
  it('a fresh running status is left alone, versions included', async () => {
    await status('running', 1)
    const s = await readClaudeCodeUpdateStatus()
    expect(s.state).toBe('running')
    expect(s.from).toBe('2.1.259')
    expect(s.to).toBe('2.1.281')
  })

  // Either side of RUNNING_MAX_MS. A push over a slow line is the reason
  // there is any slack at all past the unit's own timeout.
  it('a slow-but-live run inside the unit timeout is left alone', async () => {
    await status('running', 9)
    expect((await readClaudeCodeUpdateStatus()).state).toBe('running')
  })

  it('a running status past the unit timeout becomes failed, phase kept', async () => {
    await status('running', 15)
    const s = await readClaudeCodeUpdateStatus()
    expect(s.state).toBe('failed')
    expect(s.phase).toBe('committing')
    expect(s.error).toMatch(/stopped writing during "committing"/)
    expect(s.error).toMatch(/daedalus-claude-code-update/)
  })

  // The engine's window would call this alive. Nothing here builds, so an
  // hour of silence is an hour of a dead agent holding the button disabled.
  it("does not inherit the engine verb's hour", async () => {
    await status('running', 30)
    expect((await readClaudeCodeUpdateStatus()).state).toBe('failed')
  })

  it('terminal states are never rewritten, and no file is idle', async () => {
    for (const state of ['done', 'failed', 'idle']) {
      await status(state, 500)
      expect((await readClaudeCodeUpdateStatus()).state).toBe(state)
    }
    await rm(join(dir, 'claude-code-status.json'))
    const s = await readClaudeCodeUpdateStatus()
    expect(s.state).toBe('idle')
    expect(s.id).toBeNull()
    expect(s.from).toBe('')
  })
})
