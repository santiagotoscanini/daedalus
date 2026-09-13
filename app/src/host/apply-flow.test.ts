import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApplyOutcome } from './apply-flow'

// Two Applies must never both publish.
//
// `locked()` writes the finished bytes of apps.json and site.json into the
// bridge directory, and the host commits and rebuilds from exactly those
// bytes. A second Apply that got past the checks would replace apps.json under
// a rebuild that is about to read it — the module's own comment names that
// failure, and nothing until now proved the three things that prevent it: the
// `running` check, the pickup window that covers the gap between requesting
// and the host writing `running`, and `serialised()` keeping two callers from
// interleaving their check and their write.
//
// The bridge is real here, pointed at a temp APPLY_DIR (host/bridge.test.ts's
// archetype), because "refused" has to mean "wrote no request file" rather
// than "returned an object saying no". Everything behind it — the registry,
// the site document, the settings row — is mocked at the module boundary, so
// this file is about the lock and nothing else.
//
// `pending` and `chain` are module-scoped with no reset hook, so every test
// takes a FRESH module: `vi.resetModules()` then `await import`. Resetting
// also gives host/apply.ts (and its bridge) a fresh instance, which is
// harmless — the bridge reads APPLY_DIR per call.

const h = vi.hoisted(() => ({
  apps: [{ name: 'iris', managedInNix: false }],
  drift: ['image'] as string[],
  siteChanges: [] as string[],
}))

vi.mock('../lib/repo/apps', () => ({
  listApps: async () => h.apps,
  driftOf: () => h.drift,
  toRegistryExport: () => ({ schemaVersion: 3, apps: {} }),
}))
vi.mock('./nix-manifest', () => ({ manifestEntries: async () => [] }))
vi.mock('../core/ctx', () => ({ makeCtx: async () => ({}) }))
vi.mock('../core/site', () => ({
  siteEdit: async () => ({ changes: h.siteChanges, render: { after: '{"site":true}\n' } }),
}))
vi.mock('../lib/repo/settings', () => ({
  readSetting: async () => false,
  SETTING_KEYS: { siteCommit: 'site.commit' },
}))

let dir: string
let previousApplyDir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apply-flow-'))
  previousApplyDir = process.env.APPLY_DIR
  process.env.APPLY_DIR = dir
  h.apps = [{ name: 'iris', managedInNix: false }]
  h.drift = ['image']
  h.siteChanges = []
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
  return import('./apply-flow')
}

const hostStatus = (status: Record<string, unknown>) =>
  writeFile(join(dir, 'status.json'), JSON.stringify(status), 'utf8')

/** Id-stamped, so counting these counts requests rather than overwrites. */
const payloads = async () => (await readdir(dir)).filter((f) => f.startsWith('payload-'))

const NOT_PICKED_UP = {
  ok: false,
  code: 'busy',
  reason: 'the previous apply request has not been picked up by the host yet',
}

function idOf(outcome: ApplyOutcome): string {
  if (!outcome.ok) throw new Error(`expected an apply, got ${outcome.code}: ${outcome.reason}`)
  return outcome.id
}

describe('an apply the host is already running', () => {
  it('is refused, and writes nothing into the bridge', async () => {
    await hostStatus({ id: 'abc', state: 'running', phase: 'rebuilding' })
    const { runApply } = await flow()

    expect(await runApply('santiago')).toEqual({
      ok: false,
      code: 'busy',
      reason: 'an apply is already running (rebuilding)',
    })
    // The whole point: no request.json for the path unit to fire on, and no
    // payload to replace the bytes the running rebuild is reading.
    expect(await readdir(dir)).toEqual(['status.json'])
  })
})

describe('the pickup window', () => {
  // Between requestApply returning and apply.sh writing `running`, status.json
  // still shows the PREVIOUS run's terminal state — so the file check alone
  // reads "idle" while a request is very much in flight. PICKUP_MS (120s) is
  // how long `pending` covers that gap; keep these two either side of it.
  it('refuses inside it and clears after it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { runApply } = await flow()

    const firstId = idOf(await runApply('santiago'))
    expect(await payloads()).toEqual([`payload-${firstId}.json`])

    vi.setSystemTime(Date.now() + 119_000)
    expect(await runApply('santiago')).toEqual(NOT_PICKED_UP)
    expect(await payloads()).toHaveLength(1)

    // Past the window the host is not coming for it, and refusing forever
    // would wedge the button until a container restart.
    vi.setSystemTime(Date.now() + 2_000)
    expect(idOf(await runApply('santiago'))).not.toBe(firstId)
    expect(await payloads()).toHaveLength(2)
  })

  it('ends the moment the host acknowledges the request', async () => {
    const { runApply } = await flow()

    const firstId = idOf(await runApply('santiago'))
    await hostStatus({ id: firstId, state: 'done', phase: 'done' })

    // status.json now speaks for our request, so the `running` check is the
    // guard again and the operator does not wait out two minutes.
    expect(idOf(await runApply('santiago'))).not.toBe(firstId)
  })
})

describe('two callers at once', () => {
  it('publish exactly one request', async () => {
    const { runApply } = await flow()

    // Un-awaited on purpose: both enter before either has written anything,
    // which is the interleaving `serialised()` exists to prevent.
    const [a, b] = await Promise.all([runApply('one'), runApply('two')])

    const applied = [a, b].filter((o): o is Extract<ApplyOutcome, { ok: true }> => o.ok)
    expect([a, b].filter((o) => !o.ok)).toEqual([NOT_PICKED_UP])
    const only = applied[0]
    if (applied.length !== 1 || !only) throw new Error('both callers published')

    expect(await payloads()).toEqual([`payload-${only.id}.json`])
    // And request.json — the file the host's path unit fires on — points at
    // that one payload rather than at a second nobody can see.
    const request = JSON.parse(await readFile(join(dir, 'request.json'), 'utf8')) as { id: string }
    expect(request.id).toBe(only.id)
  })
})

describe('an apply with nothing to carry', () => {
  it('writes nothing and does not block the next one', async () => {
    h.drift = []
    const { runApply } = await flow()

    expect(await runApply('santiago')).toEqual({
      ok: false,
      code: 'noop',
      reason: 'nothing to apply',
    })
    expect(await readdir(dir)).toEqual([])

    // A no-op must not set `pending`: an idle click would otherwise refuse the
    // real Apply behind it for two minutes.
    h.drift = ['image']
    expect(idOf(await runApply('santiago'))).toBeTruthy()
  })
})
