import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../core/ctx'
import { siteFrom } from '../site'

// A new app's way to its first container (./setup.ts): what a register
// writes, when the marker clears, when the one setup Apply runs and when it is
// not run again, and the line the page draws. Every host read is mocked at
// the module boundary.

type Rec = Record<string, unknown>

const h = vi.hoisted(() => ({
  committed: null as null | { text: string; schemaVersion: number; apps: Rec },
  register: { state: 'idle', error: '' } as Rec,
  apply: { id: null, state: 'idle', error: '' } as Rec,
  manifest: [] as Rec[],
  apps: [] as Rec[],
  builds: [] as Rec[],
  image: 'missing' as string,
  changed: [] as { name: string; fields: string[] }[],
  calls: {
    register: [] as Rec[],
    marked: [] as string[],
    applies: 0,
    buildNow: [] as string[],
  },
}))

vi.mock('../../host/site-registry', () => ({
  readCommittedRegistry: async () => h.committed,
  isAwaitingEntry: (e: unknown) =>
    typeof e === 'object' && e !== null && (e as Rec).awaitingImage === true,
}))
vi.mock('../../host/register', () => ({
  readRegisterStatus: async () => h.register,
  startRegister: async (_ctx: unknown, input: Rec) => {
    h.calls.register.push(input)
    return { ok: true, id: 'reg1' }
  },
}))
vi.mock('../../host/apply', () => ({ readApplyStatus: async () => h.apply }))
vi.mock('../../host/nix-manifest', () => ({ manifestEntries: async () => h.manifest }))
vi.mock('../../host/apply-flow', () => ({
  commitSwitch: async () => true,
  currentChanges: async () => ({ changed: h.changed }),
  runApply: async () => {
    h.calls.applies += 1
    return { ok: true, id: `apply${String(h.calls.applies)}`, changed: h.changed }
  },
}))
vi.mock('../repo/apps', () => ({
  listApps: async () => h.apps,
  getApp: async (name: string) => h.apps.find((a) => a.name === name),
  markFirstImage: async (name: string) => {
    h.calls.marked.push(name)
    const a = h.apps.find((x) => x.name === name)
    if (a) a.awaitingImage = false
    return true
  },
}))
vi.mock('../repo/builds', () => ({
  listBuilds: async (appId: string) => h.builds.filter((b) => b.appId === appId),
  toBuildRow: (b: Rec) => b,
}))
vi.mock('./image-gate', () => ({
  gatedReference: () => ({ image: 'x', repo: 'x', reference: 'latest' }),
  firstImage: async () => h.image,
}))
vi.mock('../../core/builds/actions', () => ({
  buildNow: async ({ app }: { app: string }) => {
    h.calls.buildNow.push(app)
    return { ok: true, value: { id: 'b', sha: 'x', existing: false } }
  },
}))

const { registerAwaiting, settleNewApps, setupProgress } = await import('./setup')
const { renderRegistryFile } = await import('../registry-file')

const site = siteFrom({ baseDomain: 'example.org', registryHost: 'registry.example.org' })
const ctx = { site, controller: {} } as unknown as Ctx

const IRIS = { stage: 'live', postgres: true, auth: { mode: 'native' } }

function app(name: string, over: Rec = {}): Rec {
  return {
    id: `id-${name}`,
    name,
    stage: 'lab',
    awaitingImage: true,
    managedInNix: false,
    sourceMode: 'registry',
    deployEnable: true,
    image: null,
    hostname: null,
    postgres: false,
    storage: false,
    litellm: false,
    prometheus: false,
    authMode: 'native',
    authHealthPath: '/api/healthz',
    authIsolated: false,
    authAllowedGroups: null,
    authBypassRule: null,
    egressContainer: null,
    egressHostPort: null,
    limitCpus: null,
    limitMemoryMb: null,
    limitPids: null,
    description: '',
    notes: {},
    buildOnBox: true,
    envVars: [],
    tasks: [],
    ...over,
  }
}

const committed = (apps: Rec) => {
  const text = renderRegistryFile({ schemaVersion: 2, apps } as never)
  return { text, schemaVersion: 2, apps: JSON.parse(text).apps as Rec }
}

beforeEach(() => {
  h.committed = committed({ iris: IRIS })
  h.register = { state: 'idle', error: '' }
  h.apply = { id: null, state: 'idle', error: '' }
  h.manifest = [{ name: 'iris', awaitingImage: false }]
  h.apps = [app('iris', { stage: 'live', awaitingImage: false })]
  h.builds = []
  h.image = 'missing'
  h.changed = []
  h.calls = { register: [], marked: [], applies: 0, buildNow: [] }
  delete (globalThis as Rec).daedalusSetupApplyV1
  delete (globalThis as Rec).daedalusRegisterTextV1
})

describe('registerAwaiting', () => {
  it('adds the awaiting rows and keeps every other entry as written', async () => {
    h.apps.push(app('lintel'))
    const r = await registerAwaiting(ctx, 'op')
    expect(r).toEqual({ ok: true, value: 'reg1' })
    const [call] = h.calls.register
    expect(call?.summary).toBe('lintel: new')
    expect(call?.commit).toBe(true)
    const written = JSON.parse(call?.appsJson as string)
    expect(written.apps.iris).toEqual(IRIS)
    expect(written.apps.lintel.awaitingImage).toBe(true)
    expect(Object.keys(written.apps)).toEqual(['iris', 'lintel'])
  })

  it('starts nothing when the file already says so', async () => {
    h.apps.push(app('lintel'))
    const first = await registerAwaiting(ctx, 'op')
    expect(first.ok).toBe(true)
    h.committed = committed(JSON.parse(h.calls.register[0]?.appsJson as string).apps)
    expect(await registerAwaiting(ctx, 'op')).toEqual({ ok: true, value: null })
    expect(h.calls.register).toHaveLength(1)
  })

  it('drops the entry of an app deleted before its first image', async () => {
    h.committed = committed({ iris: IRIS, gone: { stage: 'lab', awaitingImage: true } })
    await registerAwaiting(ctx, 'op')
    expect(h.calls.register[0]?.summary).toBe('gone: removed before its first image')
    expect(Object.keys(JSON.parse(h.calls.register[0]?.appsJson as string).apps)).toEqual(['iris'])
  })

  it('leaves the awaiting entry of an app whose marker cleared for the Apply', async () => {
    h.committed = committed({ iris: IRIS, lintel: { stage: 'lab', awaitingImage: true } })
    h.apps.push(app('lintel', { awaitingImage: false }))
    expect(await registerAwaiting(ctx, 'op')).toEqual({ ok: true, value: null })
  })
})

describe('settleNewApps', () => {
  it('clears the marker once a live build published and the image is there', async () => {
    h.committed = committed({ iris: IRIS, lintel: { stage: 'lab', awaitingImage: true } })
    h.apps.push(app('lintel'))
    h.builds = [{ appId: 'id-lintel', lane: 'main', publish: 'live', state: 'building' }]
    await settleNewApps(ctx)
    expect(h.calls.marked).toEqual([])
    h.builds = [{ appId: 'id-lintel', lane: 'main', publish: 'live', state: 'succeeded' }]
    h.image = 'present'
    h.changed = [{ name: 'lintel', fields: ['set up'] }]
    await settleNewApps(ctx)
    expect(h.calls.marked).toEqual(['lintel'])
    // …and the Apply that sets it up, in the same tick.
    expect(h.calls.applies).toBe(1)
  })

  it('runs the setup Apply only when that is all it would carry', async () => {
    h.apps.push(app('lintel', { awaitingImage: false }))
    h.changed = [
      { name: 'lintel', fields: ['set up'] },
      { name: 'site', fields: ['timezone'] },
    ]
    await settleNewApps(ctx)
    expect(h.calls.applies).toBe(0)
    h.changed = [{ name: 'lintel', fields: ['set up'] }]
    await settleNewApps(ctx)
    expect(h.calls.applies).toBe(1)
  })

  it('does not run a failed setup Apply again, unless another app became ready', async () => {
    h.apps.push(app('lintel', { awaitingImage: false }))
    h.changed = [{ name: 'lintel', fields: ['set up'] }]
    await settleNewApps(ctx)
    h.apply = { id: 'apply1', state: 'failed', error: 'switch failed' }
    await settleNewApps(ctx)
    expect(h.calls.applies).toBe(1)
    h.apps.push(app('hermes', { awaitingImage: false }))
    h.changed = [
      { name: 'hermes', fields: ['set up'] },
      { name: 'lintel', fields: ['set up'] },
    ]
    await settleNewApps(ctx)
    expect(h.calls.applies).toBe(2)
  })

  it('waits while an Apply runs', async () => {
    h.apps.push(app('lintel', { awaitingImage: false }))
    h.changed = [{ name: 'lintel', fields: ['set up'] }]
    h.apply = { id: 'other', state: 'running', error: '' }
    await settleNewApps(ctx)
    expect(h.calls.applies).toBe(0)
  })

  it('registers an unregistered app, and not again after that same file failed', async () => {
    h.apps.push(app('lintel'))
    await settleNewApps(ctx)
    expect(h.calls.register).toHaveLength(1)
    h.register = { state: 'failed', error: 'refused' }
    await settleNewApps(ctx)
    expect(h.calls.register).toHaveLength(1)
    h.apps.push(app('hermes'))
    await settleNewApps(ctx)
    expect(h.calls.register).toHaveLength(2)
  })
})

describe('setupProgress', () => {
  const live = { containerUp: false, deployedOnce: false }
  const progressOf = async (record: Rec, manifest?: Rec) =>
    setupProgress(ctx, record as never, manifest as never, live)

  it('is setting up until the register committed the entry, and says when it failed', async () => {
    expect((await progressOf(app('lintel')))?.step).toBe('setting up')
    h.register = { state: 'failed', error: 'refused' }
    expect((await progressOf(app('lintel')))?.failed).toEqual({
      what: 'register',
      detail: 'refused',
    })
  })

  it('is building, then build failed with its log, then starting', async () => {
    h.committed = committed({ iris: IRIS, lintel: { stage: 'lab', awaitingImage: true } })
    expect((await progressOf(app('lintel')))?.failed?.what).toBe('build')
    h.builds = [{ id: 'b1', appId: 'id-lintel', lane: 'main', publish: 'live', state: 'checking' }]
    expect(await progressOf(app('lintel'))).toMatchObject({ step: 'building', failed: null })
    h.builds = [
      { id: 'b1', appId: 'id-lintel', lane: 'main', publish: 'live', state: 'failed', error: 'x' },
    ]
    expect(await progressOf(app('lintel'))).toMatchObject({
      step: 'building',
      buildId: 'b1',
      failed: { what: 'build', detail: 'x' },
    })
    h.builds = [{ id: 'b2', appId: 'id-lintel', lane: 'main', publish: 'live', state: 'succeeded' }]
    expect((await progressOf(app('lintel')))?.step).toBe('starting')
  })

  it('is starting until it runs, and nothing once it has', async () => {
    const lintel = app('lintel', { awaitingImage: false })
    expect((await progressOf(lintel))?.step).toBe('starting')
    expect((await progressOf(lintel, { name: 'lintel', awaitingImage: false }))?.step).toBe(
      'starting',
    )
    expect(
      await setupProgress(ctx, lintel as never, { name: 'lintel', awaitingImage: false } as never, {
        containerUp: true,
        deployedOnce: false,
      }),
    ).toBeNull()
  })
})
