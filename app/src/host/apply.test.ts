import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Ctx } from '../core/ctx'
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

// The status as the Apply bar reads it: a run that ended without its last
// word is failed (host/root-verb.ts), and a `reboot-required` one stays on the
// bar until the box has booted.
describe('the Apply status', () => {
  let dir: string
  let previous: string | undefined
  let follow: unknown

  const ctx = {
    controller: { call: async () => follow },
  } as unknown as Pick<Ctx, 'controller'>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'apply-'))
    previous = process.env.VERBS_DIR
    process.env.VERBS_DIR = dir
    follow = { run: { outcome: null, detail: '' } }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.VERBS_DIR
    else process.env.VERBS_DIR = previous
  })

  const status = (state: string, phase = 'building') =>
    writeFile(
      join(dir, 'apply-status.json'),
      JSON.stringify({
        id: 'abc',
        state,
        phase,
        error: '',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        commit: '',
      }),
    )

  it('a running Apply is left alone while its run goes on, and failed once it ended', async () => {
    await status('running')
    expect((await readApplyStatus(ctx)).state).toBe('running')
    follow = { run: { outcome: 'failed', detail: '' } }
    const s = await readApplyStatus(ctx)
    expect(s.state).toBe('failed')
    expect(s.phase).toBe('building')
    expect(s.error).toMatch(/ended during "building"/)
  })

  it('a reboot-required Apply the box has not booted since is pending', async () => {
    await status('done', 'reboot-required')
    expect((await readApplyStatus(ctx)).rebootPending).toBe(true)
  })
})
