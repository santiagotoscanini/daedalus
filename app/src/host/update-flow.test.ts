import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateOutcome } from './update-flow'

// What this request makes the host do is the reason to test it: rewrite a
// flake pin, commit, `nixos-rebuild switch`, verify the container came back on
// the new image, and revert when it did not. A queued batch is ONE commit and
// ONE switch, so a request that should never have been published takes every
// container in it down and back with whatever else was queued beside it.
//
// So the assertions below are all about what is NOT written: a malformed
// request, a second one racing the first, or one arriving while the host is
// mid-rebuild must leave image-request.json exactly as it was. The bridge is
// real, pointed at a temp APPLY_DIR (host/bridge.test.ts's archetype) — a
// refusal that returned the right object and still dropped the file would pass
// a test that only read the return value.
//
// `pending` and `chain` are module-scoped with no reset hook, so every test
// takes a FRESH module: `vi.resetModules()` then `await import`.

let dir: string
let previousApplyDir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'update-flow-'))
  previousApplyDir = process.env.APPLY_DIR
  process.env.APPLY_DIR = dir
})

afterEach(async () => {
  vi.useRealTimers()
  if (previousApplyDir === undefined) delete process.env.APPLY_DIR
  else process.env.APPLY_DIR = previousApplyDir
  await rm(dir, { recursive: true, force: true })
})

/** A fresh module, so the previous test's `pending` and `chain` are gone. */
async function flow() {
  vi.resetModules()
  return import('./update-flow')
}

/** `finishedAt` is rewritten at every phase, so a live run's is recent. */
const hostStatus = (status: Record<string, unknown>) =>
  writeFile(
    join(dir, 'image-status.json'),
    JSON.stringify({ finishedAt: new Date().toISOString(), ...status }),
    'utf8',
  )

const REQUEST = 'image-request.json'
const NOT_PICKED_UP = {
  ok: false,
  code: 'busy',
  reason: 'the previous update request has not been picked up by the host yet',
}

function idOf(outcome: UpdateOutcome): string {
  if (!outcome.ok) throw new Error(`expected an update, got ${outcome.code}: ${outcome.reason}`)
  return outcome.id
}

describe('a request naming no container', () => {
  it('is refused before anything is written', async () => {
    const { runImageUpdate } = await flow()

    for (const targets of [[], [{ container: '' }], [{ container: 'iris' }, { container: '' }]]) {
      expect(await runImageUpdate({ targets, actor: 'santiago' })).toEqual({
        ok: false,
        code: 'refused',
        reason: 'no container named',
      })
    }
    expect(await readdir(dir)).toEqual([])
  })
})

describe('a container named twice in one batch', () => {
  // Structural rather than factual: whether a pin exists and may move is the
  // host's call, against the nix-rendered registry that is also the allowlist.
  // A duplicate is neither — it is a malformed request, and one commit that
  // moves the same pin twice is not something the host should be asked to
  // interpret.
  it('is refused before anything is written', async () => {
    const { runImageUpdate } = await flow()

    expect(
      await runImageUpdate({
        targets: [{ container: 'immich' }, { container: 'iris' }, { container: 'immich' }],
        actor: 'santiago',
      }),
    ).toEqual({ ok: false, code: 'refused', reason: 'immich is in this request twice' })
    expect(await readdir(dir)).toEqual([])
  })
})

describe('an update the host is already running', () => {
  it('is refused, and does not replace the request it is reading', async () => {
    await hostStatus({
      id: 'abc',
      container: 'intel-gpu-exporter',
      state: 'running',
      phase: 'pull',
    })
    const { runImageUpdate } = await flow()

    expect(await runImageUpdate({ targets: [{ container: 'iris' }], actor: 'santiago' })).toEqual({
      ok: false,
      code: 'busy',
      reason: 'an update of intel-gpu-exporter is already running (pull)',
    })
    expect(await readdir(dir)).toEqual(['image-status.json'])
  })
})

describe('two callers at once', () => {
  it('publish exactly one request', async () => {
    const { runImageUpdate } = await flow()

    // Un-awaited on purpose: both enter before either has written anything.
    // The status file cannot separate them — it still says idle — so this is
    // `pending` plus the chain doing the work.
    const [a, b] = await Promise.all([
      runImageUpdate({ targets: [{ container: 'iris' }], actor: 'one' }),
      runImageUpdate({ targets: [{ container: 'anansi', toTag: 'v2' }], actor: 'two' }),
    ])

    const applied = [a, b].filter((o): o is Extract<UpdateOutcome, { ok: true }> => o.ok)
    expect([a, b].filter((o) => !o.ok)).toEqual([NOT_PICKED_UP])
    const only = applied[0]
    if (applied.length !== 1 || !only) throw new Error('both callers published')

    expect(await readdir(dir)).toEqual([REQUEST])
    const request = JSON.parse(await readFile(join(dir, REQUEST), 'utf8')) as {
      id: string
      targets: { container: string }[]
    }
    expect(request.id).toBe(idOf(only))
    // The surviving request is one caller's, not a blend of the two.
    expect(request.targets.map((t) => t.container)).toEqual(only.targets.map((t) => t.container))
  })
})
