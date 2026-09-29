import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readApplyStatus, summarise } from './apply'

describe('summarise', () => {
  it('names a no-op re-export', () => {
    expect(summarise([])).toBe('no-op re-export')
  })

  it('names a single app and its fields', () => {
    expect(summarise([{ name: 'iris', fields: ['image', 'env'] }])).toBe('iris: image, env')
  })

  it('names only the fields of a site-only change, which the host prefixes', () => {
    expect(summarise([{ name: 'site', fields: ['timezone', 'mail'] }])).toBe('timezone, mail')
  })

  it('counts and names several changes', () => {
    expect(
      summarise([
        { name: 'iris', fields: ['image'] },
        { name: 'site', fields: ['timezone'] },
      ]),
    ).toBe('2 apps updated (iris, site)')
  })
})

// A `running` status that stopped being refreshed is a corpse: the apply unit
// has no reaper, and reporting it as live would refuse every Apply for good.
describe('an Apply that stopped writing is reported as failed', () => {
  let dir: string
  let previous: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'apply-'))
    previous = process.env.APPLY_DIR
    process.env.APPLY_DIR = dir
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.APPLY_DIR
    else process.env.APPLY_DIR = previous
  })

  const status = (state: string, minutesAgo: number) =>
    writeFile(
      join(dir, 'apply-status.json'),
      JSON.stringify({
        id: 'abc',
        state,
        phase: 'building',
        error: '',
        startedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        finishedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        commit: '',
      }),
    )

  // Either side of RUNNING_MAX_MS, which follows the unit's TimeoutStartSec.
  it('a slow-but-live run inside the unit timeout is left alone', async () => {
    await status('running', 29)
    expect((await readApplyStatus()).state).toBe('running')
  })

  it('a running status past the unit timeout becomes failed, phase kept', async () => {
    await status('running', 40)
    const s = await readApplyStatus()
    expect(s.state).toBe('failed')
    expect(s.phase).toBe('building')
    expect(s.error).toMatch(/stopped writing during "building"/)
  })

  it('a finished run is never touched, however old', async () => {
    await status('done', 600)
    expect((await readApplyStatus()).state).toBe('done')
  })
})
