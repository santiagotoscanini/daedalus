import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../core/ctx'
import type { UpdateOutcome } from './update-flow'

// What this request makes the host do is the reason to test it: rewrite a
// flake pin, commit, `nixos-rebuild switch`, verify the container came back on
// the new image, and revert when it did not. A queued batch is ONE commit and
// ONE switch, so a request that should never have been started takes every
// container in it down and back with whatever else was queued beside it.
//
// So the assertions below are all about what is NOT asked: a malformed
// request, or one arriving while the host is mid-rebuild, must never reach the
// root helper. The controller is a fake Ctx's, recording every start; the status
// file is real, in a temp VERBS_DIR. A second caller racing the first is the
// helper's to refuse (one run at a time), and its refusal is the answer.
//
// `chain` is module-scoped with no reset hook, so every test takes a FRESH
// module: `vi.resetModules()` then `await import`.

const h = vi.hoisted(() => ({
  started: [] as unknown[][],
  start: [] as unknown[],
}))

const ctx = {
  controller: {
    call: async (m: string, p: { verb: string; selectors: object; payload?: string }) => {
      if (m === 'root.follow') return { run: { outcome: null, detail: '' } }
      h.started.push([p.verb, p.selectors, p.payload])
      const next = h.start.shift()
      if (next instanceof Error) throw next
      return next ?? { run: 'r1', verb: 'image-update', outcome: null, detail: '', verbs: [] }
    },
  },
} as unknown as Pick<Ctx, 'controller'>

let dir: string
let previousVerbsDir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'update-flow-'))
  previousVerbsDir = process.env.VERBS_DIR
  process.env.VERBS_DIR = dir
  h.started = []
  h.start = []
})

afterEach(async () => {
  if (previousVerbsDir === undefined) delete process.env.VERBS_DIR
  else process.env.VERBS_DIR = previousVerbsDir
  await rm(dir, { recursive: true, force: true })
})

/** A fresh module, so the previous test's `chain` is gone. */
async function flow() {
  vi.resetModules()
  return import('./update-flow')
}

const hostStatus = (status: Record<string, unknown>) =>
  writeFile(join(dir, 'image-update-status.json'), JSON.stringify(status), 'utf8')

/** The containers each start asked for. */
const startedTargets = () =>
  h.started.map((a) =>
    (JSON.parse(String(a[2])) as { targets: { container: string }[] }).targets.map(
      (t) => t.container,
    ),
  )

function idOf(outcome: UpdateOutcome): string {
  if (!outcome.ok) throw new Error(`expected an update, got ${outcome.code}: ${outcome.reason}`)
  return outcome.id
}

describe('a request naming no container', () => {
  it('is refused before anything is asked', async () => {
    const { runImageUpdate } = await flow()

    for (const targets of [[], [{ container: '' }], [{ container: 'iris' }, { container: '' }]]) {
      expect(await runImageUpdate({ ctx, targets, confirm: [], actor: 'santiago' })).toEqual({
        ok: false,
        code: 'refused',
        reason: 'no container named',
      })
    }
    expect(h.started).toEqual([])
  })
})

describe('a container named twice in one batch', () => {
  // Structural rather than factual: whether a pin exists and may move is the
  // host's call, against the nix-rendered registry that is also the allowlist.
  // A duplicate is neither — it is a malformed request, and one commit that
  // moves the same pin twice is not something the host should be asked to
  // interpret.
  it('is refused before anything is asked', async () => {
    const { runImageUpdate } = await flow()

    expect(
      await runImageUpdate({
        ctx,
        targets: [{ container: 'immich' }, { container: 'iris' }, { container: 'immich' }],
        confirm: [],
        actor: 'santiago',
      }),
    ).toEqual({ ok: false, code: 'refused', reason: 'immich is in this request twice' })
    expect(h.started).toEqual([])
  })
})

describe('an update the host is already running', () => {
  it('is refused without asking the helper', async () => {
    await hostStatus({
      id: 'abc',
      targets: ['intel-gpu-exporter'],
      state: 'running',
      phase: 'pull',
    })
    const { runImageUpdate } = await flow()

    expect(
      await runImageUpdate({
        ctx,
        targets: [{ container: 'iris' }],
        confirm: [],
        actor: 'santiago',
      }),
    ).toEqual({
      ok: false,
      code: 'busy',
      reason: 'an update of intel-gpu-exporter is already running (pull)',
    })
    expect(h.started).toEqual([])
  })
})

describe('two callers at once', () => {
  it('start one run: the helper refuses the other, and its words are the answer', async () => {
    const { runImageUpdate } = await flow()
    h.start = [
      { run: 'r1', verb: 'image-update', outcome: null, detail: '', verbs: [] },
      {
        run: 'r2',
        verb: 'image-update',
        outcome: 'refused',
        detail: 'daedalus-image-update@r1 is still running; wait for it to finish',
        verbs: [],
      },
    ]

    // Un-awaited on purpose: both enter before either has started. The status
    // file cannot separate them — the unit has not written it yet — so this is
    // the helper's one-run-at-a-time doing the work.
    const [a, b] = await Promise.all([
      runImageUpdate({ ctx, targets: [{ container: 'iris' }], confirm: [], actor: 'one' }),
      runImageUpdate({
        ctx,
        targets: [{ container: 'anansi', toTag: 'v2' }],
        confirm: [],
        actor: 'two',
      }),
    ])
    expect(idOf(a)).toBe('r1')
    expect(b).toEqual({
      ok: false,
      code: 'busy',
      reason: 'daedalus-image-update@r1 is still running; wait for it to finish',
    })
    expect(startedTargets()).toEqual([['iris'], ['anansi']])
  })

  it('no controller is unavailable, with why', async () => {
    const { runImageUpdate } = await flow()
    h.start = [new Error('no socket at /controller/api.sock')]
    expect(
      await runImageUpdate({ ctx, targets: [{ container: 'iris' }], confirm: [], actor: 'one' }),
    ).toEqual({ ok: false, code: 'unavailable', reason: 'no socket at /controller/api.sock' })
  })
})

describe('a pin that owes a ceremony', () => {
  // The typed-name gate is runImageUpdate's, so the Updates panel and the MCP
  // tool cannot differ on it — the panel's own check runs in the browser, which
  // is no check at all. The pins come from /export/images.json, as on the box.
  let previousExportDir: string | undefined

  beforeEach(async () => {
    previousExportDir = process.env.EXPORT_DIR
    process.env.EXPORT_DIR = dir
    const pin = (tag: string, ceremony: string | null, majorCeremony: string | null = null) => ({
      image: `example/${tag}`,
      repo: 'example',
      tag,
      digest: 'sha256:0',
      ceremony,
      majorCeremony,
    })
    await writeFile(
      join(dir, 'images.json'),
      JSON.stringify({
        daedalusExport: 1,
        domain: 'images',
        schemaVersion: 2,
        source: 'nix',
        generatedAt: new Date().toISOString(),
        data: {
          pins: {
            pg: pin('17', 'restarts every tenant of the shared cluster'),
            iris: pin('1', null),
            immich: pin('1.0', null, 'migrates its database'),
          },
        },
      }),
    )
  })

  afterEach(() => {
    if (previousExportDir === undefined) delete process.env.EXPORT_DIR
    else process.env.EXPORT_DIR = previousExportDir
  })

  const requests = () => startedTargets()

  it('is refused unless its name was typed, and nothing is asked', async () => {
    const { runImageUpdate } = await flow()
    for (const confirm of [[], ['PG'], ['iris']]) {
      expect(
        await runImageUpdate({ ctx, targets: [{ container: 'pg' }], confirm, actor: 'santiago' }),
      ).toEqual({
        ok: false,
        code: 'refused',
        reason:
          'Updating pg restarts every tenant of the shared cluster. Pass confirm: "pg" to proceed.',
      })
    }
    expect(requests()).toEqual([])
  })

  it('is refused in a batch when only the other pin was typed', async () => {
    const { runImageUpdate } = await flow()
    const outcome = await runImageUpdate({
      ctx,
      targets: [{ container: 'iris' }, { container: 'pg' }],
      confirm: ['iris'],
      actor: 'santiago',
    })
    expect(outcome.ok).toBe(false)
    expect(requests()).toEqual([])
  })

  it('goes ahead with the name typed', async () => {
    const { runImageUpdate } = await flow()
    const outcome = await runImageUpdate({
      ctx,
      targets: [{ container: 'iris' }, { container: 'pg' }],
      confirm: [' pg '],
      actor: 'santiago',
    })
    idOf(outcome)
    expect(requests()).toEqual([['iris', 'pg']])
  })

  it('owes a major ceremony only for a move to a new major', async () => {
    const { runImageUpdate } = await flow()
    const major = await runImageUpdate({
      ctx,
      targets: [{ container: 'immich', toTag: '2.0' }],
      confirm: [],
      actor: 'santiago',
    })
    expect(major).toMatchObject({ ok: false, code: 'refused' })
    idOf(
      await runImageUpdate({
        ctx,
        targets: [{ container: 'immich', toTag: '1.1' }],
        confirm: [],
        actor: 'santiago',
      }),
    )
  })
})
