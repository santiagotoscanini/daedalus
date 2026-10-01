import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../core/ctx'

// The version update's one flow: malformed input and a run in flight are
// refused without asking the root helper; otherwise the request is the
// payload of a detached `version-update`, and the run's id is the answer. A
// fake Ctx's controller records the starts; the status file is real, in a
// temp VERBS_DIR.

let dir: string
let started: unknown[][]
let follow: unknown

const ctx = {
  controller: {
    call: async (m: string, p: { verb: string; selectors: object; payload?: string }) => {
      if (m === 'root.follow') return follow
      started.push([p.verb, p.selectors, p.payload])
      return { run: 'r1', verb: 'version-update', outcome: null, detail: '', verbs: [] }
    },
  },
} as unknown as Pick<Ctx, 'controller'>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verupd-'))
  process.env.VERBS_DIR = dir
  started = []
  follow = { run: { outcome: null, detail: '' } }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  delete process.env.VERBS_DIR
})

/** A fresh module, so the previous test's chain is gone. */
async function flow() {
  vi.resetModules()
  return import('./version-update')
}

describe('runVersionUpdate', () => {
  it('refuses malformed input without asking', async () => {
    const { runVersionUpdate } = await flow()
    expect(
      await runVersionUpdate({ ctx, target: 'Mine craft', values: { version: '1' }, actor: 'a' }),
    ).toEqual({ ok: false, code: 'refused', reason: 'no target named' })
    expect(
      await runVersionUpdate({ ctx, target: 'minecraft', values: { version: '1;x' }, actor: 'a' }),
    ).toEqual({ ok: false, code: 'refused', reason: 'version = 1;x is not a valid pin' })
    expect(started).toEqual([])
  })

  it('refuses while a run is in flight, and starts one otherwise', async () => {
    await writeFile(
      join(dir, 'version-update-status.json'),
      JSON.stringify({ id: 'r0', target: 'minecraft', state: 'running', phase: 'building' }),
    )
    const { runVersionUpdate } = await flow()
    const input = { ctx, target: 'minecraft', values: { version: '1.21.9' }, actor: 'santiago' }
    expect(await runVersionUpdate(input)).toEqual({
      ok: false,
      code: 'busy',
      reason: 'an update of minecraft is already running (building)',
    })
    expect(started).toEqual([])

    // The run ended without its last word: no longer in flight.
    follow = { run: { outcome: 'failed', detail: '' } }
    expect(await runVersionUpdate(input)).toEqual({ ok: true, id: 'r1', target: 'minecraft' })
    expect(started[0]?.slice(0, 2)).toEqual(['version-update', {}])
    expect(JSON.parse(String(started[0]?.[2]))).toEqual({
      target: 'minecraft',
      values: { version: '1.21.9' },
      actor: 'santiago',
    })
  })
})
