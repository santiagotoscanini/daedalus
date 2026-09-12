import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuildRow } from '../../lib/build-queue'
import type { BuildStatus } from '../../lib/builds'
import type { Ctx } from '../ctx'

// The scheduler against mocked edges: the bridge files, the repositories,
// GitHub and the reporter. Nothing here touches a database or the filesystem.

const NOW = new Date('2026-09-12T10:00:00Z')
const ID = '0b6f3c1e-8a2d-4e5f-9c7b-1d2e3f4a5b6c'
const ID2 = '1c7f4d2e-9b3e-4f6a-8d8c-2e3f4a5b6c7d'
const APP_ID = 'a1a1a1a1-0000-4000-8000-000000000001'
const SHA = '159be4d0c2a1f3e4b5d6c7a8e9f0a1b2c3d4e5f6'
const TIP = '2a8f0c1d3e4b5a6978c0d1e2f3a4b5c6d7e8f901'

type Rec = Record<string, unknown>

const h = vi.hoisted(() => ({
  status: {
    data: null as unknown,
    available: false,
    stale: false,
    error: null as string | null,
    generatedAt: null,
    ageMs: null,
  },
  active: [] as unknown[],
  queued: [] as unknown[],
  builds: new Map<string, unknown>(),
  latest: undefined as unknown,
  history: [] as unknown[],
  claim: undefined as unknown,
  update: undefined as unknown,
  apps: [] as unknown[],
  manifest: [] as unknown[],
  repos: { ok: true, repos: [] as unknown[], total: 0 } as unknown,
  heads: {} as Record<string, unknown>,
  tokenOk: true,
  pinResult: true,
  installation: { available: true, data: { state: 'ok' } } as unknown,
  calls: {
    request: [] as unknown[],
    claim: [] as unknown[],
    update: [] as unknown[][],
    insert: [] as unknown[],
    pin: [] as unknown[][],
    report: [] as unknown[],
    reportTick: 0,
    readStatus: 0,
    prune: [] as unknown[],
    gh: [] as string[],
    store: [] as unknown[][],
  },
  readStatusHook: null as null | (() => Promise<void>),
}))

vi.mock('../../lib/build-bridge', () => ({
  readBuildStatus: async () => {
    h.calls.readStatus++
    if (h.readStatusHook) await h.readStatusHook()
    return h.status
  },
  requestBuild: async (req: unknown) => {
    h.calls.request.push(req)
  },
}))

vi.mock('../../lib/repo/builds', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/repo/builds')>()
  return {
    toBuildRow: real.toBuildRow,
    activeBuilds: async () => h.active,
    queuedBuilds: async () => h.queued,
    getBuild: async (id: string) => h.builds.get(id),
    latestSucceeded: async () => h.latest,
    buildsOfSha: async () => h.history,
    claimQueued: async (id: string, now: Date) => {
      h.calls.claim.push(id)
      return typeof h.claim === 'function'
        ? (h.claim as (i: string, n: Date) => unknown)(id, now)
        : h.claim
    },
    updateFromStatus: async (id: string, patch: Rec, source: string) => {
      h.calls.update.push([id, patch, source])
      return typeof h.update === 'function'
        ? (h.update as (i: string, p: Rec) => unknown)(id, patch)
        : h.update
    },
    insertOrSupersedeQueued: async (input: unknown) => {
      h.calls.insert.push(input)
      return { row: input, superseded: [], alreadyQueued: false }
    },
    pinGithubRepoId: async (appId: string, repoId: number) => {
      h.calls.pin.push([appId, repoId])
      return h.pinResult
    },
  }
})
vi.mock('../../lib/repo/apps', () => ({ listApps: async () => h.apps }))
vi.mock('../../lib/repo/github-deliveries', () => ({
  pruneDeliveries: async (d: Date) => {
    h.calls.prune.push(d)
    return 0
  },
}))
vi.mock('../../lib/repo/settings', () => ({
  SETTING_KEYS: { buildsLastSweep: 'builds.lastSweep' },
}))
vi.mock('../../lib/nix-manifest', () => ({ manifestEntries: async () => h.manifest }))
vi.mock('../../lib/github-token', () => ({ tokenUsable: () => h.tokenOk }))
vi.mock('../github-app', () => ({
  installationState: async () => h.installation,
  listInstallationRepos: async () => h.repos,
  ghApp: async (_ctx: unknown, path: string) => {
    h.calls.gh.push(path)
    const sha = h.heads[path]
    return sha === undefined
      ? { status: 404, body: null, headers: new Headers(), retryAfterMs: null, error: null }
      : { status: 200, body: { sha }, headers: new Headers(), retryAfterMs: null, error: null }
  },
  describeGhFailure: () => 'GitHub answered 404.',
}))
vi.mock('./report', () => ({
  reportBuildChange: async (_ctx: unknown, row: unknown) => {
    h.calls.report.push(row)
  },
  reportTick: async () => {
    h.calls.reportTick++
  },
}))

const ctx = {
  store: {
    write: async (key: string, value: unknown) => {
      h.calls.store.push([key, value])
    },
  },
} as unknown as Ctx
vi.mock('../ctx', () => ({ makeCtx: async () => ctx }))

const scheduler = await import('./scheduler')
const {
  freshState,
  runSweep,
  runTick,
  planDispatch,
  BOX_BUILDS_OFF,
  NO_INSTALLATION,
  PICKUP_MS,
  REQUEST_TOO_LARGE,
} = scheduler

function row(over: Partial<BuildRow> = {}): BuildRow {
  return {
    id: ID,
    appId: APP_ID,
    app: 'iris',
    lane: 'main',
    prNumber: null,
    sha: SHA,
    strategy: 'dockerfile',
    resolvedStrategy: null,
    publish: 'live',
    requestedBy: 'webhook',
    actor: null,
    deliveryId: null,
    state: 'queued',
    phase: '',
    error: null,
    detected: null,
    warnings: [],
    checks: null,
    digest: null,
    imageRef: null,
    sizeBytes: null,
    timings: {},
    checkRunId: null,
    deploymentId: null,
    reported: false,
    createdAt: new Date(NOW.getTime() - 60_000),
    startedAt: null,
    updatedAt: new Date(NOW.getTime() - 60_000),
    ...over,
  }
}

/** A BuildRow as the repository's record (no `app`, nullable json columns). */
function record(r: BuildRow): Rec {
  const { app: _app, ...rest } = r
  return rest
}

function app(over: Rec = {}): Rec {
  return {
    id: APP_ID,
    name: 'iris',
    managedInNix: false,
    sourceMode: 'registry',
    buildOnBox: true,
    githubRepoId: 555,
    buildStrategy: 'dockerfile',
    buildPublish: 'live',
    buildEnvPlaceholders: { AUTH_SECRET: 'placeholder' },
    railpackEnv: { RAILPACK_PRUNE_DEPS: 'true' },
    ...over,
  }
}

function status(over: Partial<BuildStatus> = {}): BuildStatus {
  return {
    version: 1,
    id: ID,
    app: 'iris',
    sha: SHA,
    state: 'building',
    phase: 'building image',
    strategy: 'dockerfile',
    tip: null,
    digest: null,
    imageRef: null,
    sizeBytes: null,
    pinned: false,
    candidate: false,
    detected: null,
    checks: null,
    error: null,
    timings: {},
    updatedAt: NOW.toISOString(),
    ...over,
  }
}

function setStatus(s: BuildStatus | null, stale = false) {
  h.status = { ...h.status, data: s, available: s !== null, stale }
}

beforeEach(() => {
  setStatus(null)
  h.active = []
  h.queued = []
  h.builds = new Map()
  h.latest = undefined
  h.history = []
  h.claim = undefined
  h.update = (id: string, patch: Rec) => ({ ...record(row({ id })), ...patch })
  h.apps = [app()]
  h.manifest = [{ name: 'iris', managedInNix: false, sourceMode: 'registry' }]
  h.repos = { ok: true, repos: [], total: 0 }
  h.heads = {}
  h.tokenOk = true
  h.pinResult = true
  h.installation = { available: true, data: { state: 'ok' } }
  h.readStatusHook = null
  h.calls = {
    request: [],
    claim: [],
    update: [],
    insert: [],
    pin: [],
    report: [],
    reportTick: 0,
    readStatus: 0,
    prune: [],
    gh: [],
    store: [],
  }
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  scheduler.stopScheduler()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('dispatch', () => {
  it('writes the request only after a successful claim, with the build env', async () => {
    const q = row()
    h.queued = [q]
    h.claim = { ...record(q), state: 'cloning', phase: 'requested', startedAt: NOW, updatedAt: NOW }
    const state = freshState(NOW.getTime())

    expect(await runTick(ctx, NOW, state)).toBe(true)
    expect(h.calls.claim).toEqual([ID])
    expect(h.calls.request).toEqual([
      {
        version: 1,
        id: ID,
        app: 'iris',
        sha: SHA,
        repoId: 555,
        strategy: 'dockerfile',
        publish: 'live',
        requestedBy: 'webhook',
        at: NOW.toISOString(),
        buildEnv: {
          placeholders: { AUTH_SECRET: 'placeholder' },
          railpack: { RAILPACK_PRUNE_DEPS: 'true' },
        },
      },
    ])
    expect(state.pending).toEqual({ id: ID, at: NOW.getTime() })
    expect(h.calls.report).toHaveLength(1)
    expect(h.calls.reportTick).toBe(1)
  })

  it('writes nothing when the claim is lost', async () => {
    h.queued = [row()]
    h.claim = undefined
    expect(await runTick(ctx, NOW, freshState(NOW.getTime()))).toBe(false)
    expect(h.calls.claim).toEqual([ID])
    expect(h.calls.request).toEqual([])
  })

  it('holds an app with no pinned repository', async () => {
    h.queued = [row()]
    h.apps = [app({ githubRepoId: null })]
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.claim).toEqual([])
    expect(h.calls.request).toEqual([])
    expect(h.calls.update).toEqual([])
  })

  it('holds an app not in apps.json yet', async () => {
    h.queued = [row()]
    h.manifest = []
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.claim).toEqual([])
    expect(h.calls.update).toEqual([])
  })

  it('cancels a queued build whose app has box builds off, and reports it', async () => {
    h.queued = [row()]
    h.apps = [app({ buildOnBox: false })]
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.claim).toEqual([])
    expect(h.calls.request).toEqual([])
    expect(h.calls.update).toEqual([
      [
        ID,
        { state: 'cancelled', error: BOX_BUILDS_OFF, phase: 'cancelled', updatedAt: NOW },
        'engine',
      ],
    ])
    expect((h.calls.report[0] as BuildRow).state).toBe('cancelled')
  })

  it('fails a build whose env the contract refuses instead of claiming it', async () => {
    h.queued = [row()]
    h.apps = [app({ railpackEnv: { NODE_ENV: 'production' } })]
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.claim).toEqual([])
    const [id, patch, source] = h.calls.update[0] ?? []
    expect([id, source]).toEqual([ID, 'engine'])
    expect((patch as Rec).state).toBe('failed')
    expect((patch as Rec).error).toMatch(/^request refused: buildEnv\.railpack/)
  })

  it('fails a build whose env a stored setting carried past the rules', async () => {
    h.queued = [row()]
    h.apps = [app({ railpackEnv: { RAILPACK_START_CMD: 'node evil.mjs' } })]
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.request).toEqual([])
    expect((h.calls.update[0]?.[1] as Rec | undefined)?.error).toContain(
      "RAILPACK_START_CMD is a command, and start, build and install commands belong in the repo's railpack.json",
    )
  })

  it('fails a request too large to write, without claiming it', async () => {
    h.queued = [row()]
    const placeholders = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`K${String(i)}`, '€'.repeat(512)]),
    )
    h.apps = [app({ buildEnvPlaceholders: placeholders, railpackEnv: {} })]
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.claim).toEqual([])
    expect(h.calls.request).toEqual([])
    expect(h.calls.update).toEqual([
      [
        ID,
        { state: 'failed', error: REQUEST_TOO_LARGE, phase: 'failed', updatedAt: NOW },
        'engine',
      ],
    ])
    expect(REQUEST_TOO_LARGE).toBe('request refused: too large')
  })

  it('does not dispatch while the host reports a fresh unfinished build', async () => {
    h.queued = [row({ id: ID2 })]
    setStatus(status({ id: ID, state: 'checking' }))
    expect(await runTick(ctx, NOW, freshState(NOW.getTime()))).toBe(true)
    expect(h.calls.claim).toEqual([])
  })

  it('does not re-send while the last request awaits pickup', async () => {
    h.queued = [row({ id: ID2 })]
    h.claim = { ...record(row({ id: ID2 })), state: 'cloning' }
    const state = freshState(NOW.getTime())
    state.pending = { id: ID, at: NOW.getTime() - 10_000 }
    await runTick(ctx, NOW, state)
    expect(h.calls.request).toEqual([])

    const later = new Date(NOW.getTime() - 10_000 + PICKUP_MS)
    await runTick(ctx, later, state)
    expect(h.calls.request).toHaveLength(1)
  })

  it('cancels queued builds when the App is not installed, leaving the running one', async () => {
    h.installation = { available: true, data: { state: 'not-installed' } }
    h.active = [
      row({
        state: 'building',
        phase: 'building image',
        resolvedStrategy: 'dockerfile',
        startedAt: NOW,
        updatedAt: NOW,
      }),
    ]
    setStatus(status())
    h.queued = [row({ id: ID2 })]

    expect(await runTick(ctx, NOW, freshState(NOW.getTime()))).toBe(true)
    expect(h.calls.update).toEqual([
      [
        ID2,
        { state: 'cancelled', error: NO_INSTALLATION, phase: 'cancelled', updatedAt: NOW },
        'engine',
      ],
    ])
    expect(h.calls.claim).toEqual([])
  })

  it('does not read an unavailable installation file as uninstalled', async () => {
    h.installation = { available: false, data: { state: 'error' } }
    h.queued = [row()]
    h.claim = { ...record(row()), state: 'cloning' }
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.request).toHaveLength(1)
  })

  it('cancels a box-builds-off row even while another build is in flight', async () => {
    setStatus(status({ id: ID, state: 'checking' }))
    h.queued = [row({ id: ID2 })]
    h.apps = [app({ buildOnBox: false })]
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.update.map((c) => [c[0], (c[1] as Rec).error])).toEqual([[ID2, BOX_BUILDS_OFF]])
    expect(h.calls.claim).toEqual([])
  })

  it('plans cancellations before holds, and a held row never runs', () => {
    const apps = new Map([
      ['iris', app() as never],
      ['argus', app({ name: 'argus', githubRepoId: null }) as never],
      ['voyra', app({ name: 'voyra', buildOnBox: false }) as never],
    ])
    const queued = [
      row({ id: 'v', app: 'voyra' }),
      row({ id: 'a', app: 'argus' }),
      row({ id: 'i', app: 'iris' }),
    ]
    const plan = planDispatch(queued, apps, {
      inManifest: new Set(['iris', 'argus', 'voyra']),
      installed: true,
    })
    expect(plan.cancel.map((c) => [c.row.id, c.error])).toEqual([['v', BOX_BUILDS_OFF]])
    expect(plan.held.map((x) => x.row.id)).toEqual(['a'])
    expect(plan.next?.id).toBe('i')

    expect(planDispatch(queued, apps, { inManifest: null, installed: true }).next).toBeNull()
    expect(
      planDispatch(queued, apps, { inManifest: new Set(['iris']), installed: false }).cancel.map(
        (c) => c.error,
      ),
    ).toEqual([NO_INSTALLATION, NO_INSTALLATION, NO_INSTALLATION])
  })
})

describe('status', () => {
  it('applies the host status to the running row and reports the change once', async () => {
    const running = row({
      state: 'cloning',
      phase: 'cloning',
      startedAt: NOW,
      updatedAt: new Date(NOW.getTime() - 5_000),
    })
    h.active = [running]
    setStatus(status({ state: 'building', phase: 'building image', strategy: 'railpack' }))
    const state = freshState(NOW.getTime())

    expect(await runTick(ctx, NOW, state)).toBe(true)
    expect(h.calls.update).toHaveLength(1)
    const [id, patch, source] = h.calls.update[0] ?? []
    expect([id, source]).toEqual([ID, 'host'])
    expect(patch).toMatchObject({
      state: 'building',
      phase: 'building image',
      resolvedStrategy: 'railpack',
    })
    expect(h.calls.report).toHaveLength(1)
    expect((h.calls.report[0] as BuildRow).state).toBe('building')

    // The same file on the next tick, the row now caught up: no write, no report.
    h.active = [
      {
        ...running,
        state: 'building',
        phase: 'building image',
        resolvedStrategy: 'railpack',
        updatedAt: NOW,
      },
    ]
    await runTick(ctx, new Date(NOW.getTime() + 3_000), state)
    expect(h.calls.update).toHaveLength(1)
    expect(h.calls.report).toHaveLength(1)
  })

  it('writes a heartbeat without reporting it', async () => {
    h.active = [
      row({
        state: 'building',
        phase: 'building image',
        startedAt: NOW,
        updatedAt: new Date(NOW.getTime() - 30_000),
      }),
    ]
    setStatus(status())
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.update).toHaveLength(1)
    expect(h.calls.report).toHaveLength(0)
  })

  it('writes detection only when it changed, and never a list row’s empty fields', async () => {
    const detected = { info: { railpackVersion: '0.39.0' } }
    const running = row({ state: 'detecting', phase: 'railpack prepare', startedAt: NOW })
    const state = freshState(NOW.getTime())
    const beat = async (at: Date, over: Partial<BuildStatus>, rowHeardAt: Date) => {
      h.active = [{ ...running, updatedAt: rowHeardAt }]
      setStatus(
        status({
          state: 'detecting',
          phase: 'railpack prepare',
          updatedAt: at.toISOString(),
          ...over,
        }),
      )
      await runTick(ctx, at, state)
      return h.calls.update.at(-1)?.[1] as Rec
    }

    const t1 = NOW
    const first = await beat(
      t1,
      { detected, timings: { cloning: 900 } },
      new Date(t1.getTime() - 20_000),
    )
    expect(first).toMatchObject({ detected, timings: { cloning: 900 } })
    expect(first).not.toHaveProperty('checks')
    expect(state.detectedSeen).toMatchObject({ id: ID })

    const t2 = new Date(t1.getTime() + 20_000)
    const second = await beat(
      t2,
      { detected: structuredClone(detected), timings: { cloning: 900 } },
      t1,
    )
    expect(h.calls.update).toHaveLength(2)
    expect(second).not.toHaveProperty('detected')
    expect(second).toMatchObject({ timings: { cloning: 900 } })

    const changed = { info: { railpackVersion: '0.39.0', detectedProviders: ['node'] } }
    const t3 = new Date(t2.getTime() + 20_000)
    expect(await beat(t3, { detected: changed }, t2)).toMatchObject({ detected: changed })

    // A status that carries none of them writes none of them.
    const t4 = new Date(t3.getTime() + 20_000)
    const bare = await beat(t4, {}, t3)
    for (const k of ['detected', 'checks', 'timings', 'warnings'])
      expect(bare).not.toHaveProperty(k)
  })

  it('fails a row whose status went stale as interrupted', async () => {
    const old = new Date(NOW.getTime() - 120_000)
    h.active = [row({ state: 'building', phase: 'building image', startedAt: old, updatedAt: old })]
    setStatus(status({ updatedAt: old.toISOString() }), true)

    await runTick(ctx, NOW, freshState(NOW.getTime()))
    const [id, patch, source] = h.calls.update[0] ?? []
    expect([id, source]).toEqual([ID, 'engine'])
    expect(patch).toMatchObject({ state: 'failed', error: 'interrupted' })
    for (const k of ['detected', 'checks', 'timings']) expect(patch).not.toHaveProperty(k)
    expect((h.calls.report[0] as BuildRow).state).toBe('failed')
  })

  it('fails a dispatched row the host never picked up as interrupted', async () => {
    const at = new Date(NOW.getTime() - 100_000)
    h.active = [row({ state: 'cloning', phase: 'requested', startedAt: at, updatedAt: at })]
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.update[0]?.[1]).toMatchObject({ state: 'failed', error: 'interrupted' })
    expect(h.calls.update[0]?.[2]).toBe('engine')
  })

  it("lets the host's terminal word replace an engine verdict", async () => {
    const failed = row({ state: 'failed', error: 'interrupted', startedAt: NOW, reported: true })
    h.builds.set(ID, { ...record(failed), app: 'iris' })
    setStatus(status({ state: 'failed', phase: 'building', error: 'building: step OOM' }))
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    const [id, patch, source] = h.calls.update[0] ?? []
    expect([id, source]).toEqual([ID, 'host'])
    expect(patch).toMatchObject({ state: 'failed', error: 'building: step OOM' })
  })

  it('enqueues the tip of a superseded build once, as the sweep, in the same publish mode', async () => {
    const running = row({
      state: 'cloning',
      phase: 'cloning',
      publish: 'candidate',
      startedAt: NOW,
      updatedAt: NOW,
    })
    h.active = [running]
    setStatus(status({ state: 'superseded', phase: 'superseded', tip: TIP }))
    const state = freshState(NOW.getTime())

    await runTick(ctx, NOW, state)
    expect(h.calls.insert).toHaveLength(1)
    expect(h.calls.insert[0]).toMatchObject({
      sha: TIP,
      requestedBy: 'sweep',
      publish: 'candidate',
      appId: APP_ID,
    })

    // Re-read next tick: the row is final now, so nothing more is enqueued.
    h.active = []
    h.builds.set(ID, { ...record({ ...running, state: 'superseded' }), app: 'iris' })
    await runTick(ctx, new Date(NOW.getTime() + 3_000), state)
    await runTick(ctx, new Date(NOW.getTime() + 6_000), state)
    expect(h.calls.insert).toHaveLength(1)
  })

  it('does not enqueue the tip of a superseded build when that tip last failed', async () => {
    h.active = [row({ state: 'cloning', startedAt: NOW, updatedAt: NOW })]
    setStatus(status({ state: 'superseded', tip: TIP }))
    h.history = [row({ id: ID2, sha: TIP, state: 'failed', error: 'check failed: lint' })]
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.update).toHaveLength(1)
    expect(h.calls.insert).toEqual([])
  })

  it('does not enqueue the tip when a concurrent tick already moved the row', async () => {
    h.active = [row({ state: 'cloning', startedAt: NOW, updatedAt: NOW })]
    setStatus(status({ state: 'superseded', tip: TIP }))
    h.update = undefined
    await runTick(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.insert).toEqual([])
    expect(h.calls.report).toEqual([])
  })
})

describe('sweep', () => {
  const repo = (id: number, name: string, over: Rec = {}) => ({
    id,
    name,
    fullName: `octo/${name}`,
    private: true,
    archived: false,
    defaultBranch: 'main',
    htmlUrl: `https://github.com/octo/${name}`,
    pushedAt: null,
    ...over,
  })

  it('pins by exact name, never overwrites, and skips nix-managed apps', async () => {
    h.apps = [
      app({ id: 'id-iris', name: 'iris', githubRepoId: null, buildOnBox: false }),
      app({ id: 'id-hermes', name: 'hermes', githubRepoId: 42, buildOnBox: false }),
      app({ id: 'id-argus', name: 'argus', githubRepoId: null, buildOnBox: false }),
      app({
        id: 'id-daedalus',
        name: 'daedalus',
        githubRepoId: null,
        managedInNix: true,
        sourceMode: 'local',
      }),
    ]
    h.repos = {
      ok: true,
      repos: [
        repo(101, 'Iris'),
        repo(102, 'hermes'),
        repo(103, 'daedalus'),
        repo(104, 'argus-old'),
      ],
      total: 4,
    }
    const state = freshState(NOW.getTime())
    const out = await runSweep(ctx, NOW, state)

    expect(h.calls.pin).toEqual([['id-iris', 101]])
    expect(out.pinned).toEqual(['iris'])
    expect(Object.keys(state.logged)).toContain('pin-mismatch:hermes')
    expect(h.calls.gh).toEqual([])
    expect(h.calls.store[0]?.[0]).toBe('builds.lastSweep')
    expect((h.calls.prune[0] as Date).getTime()).toBe(NOW.getTime() - 7 * 24 * 3_600_000)
  })

  it('enqueues a HEAD that differs from the last successful build', async () => {
    h.apps = [app({ githubRepoId: 101, buildStrategy: 'railpack', buildPublish: 'candidate' })]
    h.repos = { ok: true, repos: [repo(101, 'iris', { defaultBranch: 'release/v1' })], total: 1 }
    h.heads = { '/repos/octo/iris/commits/release/v1': TIP }
    h.latest = { ...record(row({ state: 'succeeded', sha: SHA })), app: 'iris' }

    const out = await runSweep(ctx, NOW, freshState(NOW.getTime()))
    expect(out.enqueued).toEqual(['iris'])
    expect(h.calls.insert).toHaveLength(1)
    expect(h.calls.insert[0]).toMatchObject({
      appId: APP_ID,
      sha: TIP,
      requestedBy: 'sweep',
      strategy: 'railpack',
      publish: 'candidate',
    })
  })

  it('skips a HEAD already built, queued or running', async () => {
    h.apps = [app({ githubRepoId: 101 })]
    h.repos = { ok: true, repos: [repo(101, 'iris')], total: 1 }
    h.heads = { '/repos/octo/iris/commits/main': SHA }

    h.latest = { ...record(row({ state: 'succeeded', sha: SHA })), app: 'iris' }
    await runSweep(ctx, NOW, freshState(NOW.getTime()))
    h.latest = undefined
    h.queued = [row({ sha: SHA })]
    await runSweep(ctx, NOW, freshState(NOW.getTime()))
    h.queued = []
    h.active = [row({ sha: SHA, state: 'building' })]
    await runSweep(ctx, NOW, freshState(NOW.getTime()))

    expect(h.calls.gh).toHaveLength(3)
    expect(h.calls.insert).toEqual([])
  })

  it('does not rebuild a HEAD whose last build failed, hour after hour', async () => {
    h.apps = [app({ githubRepoId: 101 })]
    h.repos = { ok: true, repos: [repo(101, 'iris')], total: 1 }
    h.heads = { '/repos/octo/iris/commits/main': TIP }
    h.history = [row({ sha: TIP, state: 'failed', error: 'check failed: lint', startedAt: NOW })]

    for (let hour = 0; hour < 3; hour++) {
      const at = new Date(NOW.getTime() + hour * 3_600_000)
      expect((await runSweep(ctx, at, freshState(at.getTime()))).enqueued).toEqual([])
    }
    expect(h.calls.gh).toHaveLength(3)
    expect(h.calls.insert).toEqual([])
  })

  it('tries a HEAD the engine failed as interrupted once more, then leaves it', async () => {
    h.apps = [app({ githubRepoId: 101 })]
    h.repos = { ok: true, repos: [repo(101, 'iris')], total: 1 }
    h.heads = { '/repos/octo/iris/commits/main': TIP }
    const firstTry = row({
      sha: TIP,
      state: 'failed',
      error: 'interrupted',
      createdAt: new Date(NOW.getTime() - 7_200_000),
    })

    h.history = [firstTry]
    expect((await runSweep(ctx, NOW, freshState(NOW.getTime()))).enqueued).toEqual(['iris'])

    h.history = [row({ id: ID2, sha: TIP, state: 'failed', error: 'interrupted' }), firstTry]
    expect((await runSweep(ctx, NOW, freshState(NOW.getTime()))).enqueued).toEqual([])
    expect(h.calls.insert).toHaveLength(1)
  })

  it('never reads HEAD for an app with box builds off', async () => {
    h.apps = [app({ githubRepoId: 101, buildOnBox: false })]
    h.repos = { ok: true, repos: [repo(101, 'iris')], total: 1 }
    await runSweep(ctx, NOW, freshState(NOW.getTime()))
    expect(h.calls.gh).toEqual([])
  })

  it('skips GitHub without a usable token, still pruning and recording', async () => {
    h.tokenOk = false
    h.apps = [app({ githubRepoId: null })]
    const out = await runSweep(ctx, NOW, freshState(NOW.getTime()))
    expect(out.skipped).toBe('no usable installation token')
    expect(h.calls.pin).toEqual([])
    expect(h.calls.prune).toHaveLength(1)
    expect(h.calls.store).toHaveLength(1)
  })

  it('logs a listing failure once per hour and backs off on a rate limit', async () => {
    h.repos = { ok: false, reason: "GitHub's rate limit is spent", retryAfterMs: 600_000 }
    const state = freshState(NOW.getTime())
    const warn = vi.mocked(console.warn)
    await runSweep(ctx, NOW, state)
    expect(state.githubBackoffUntil).toBe(NOW.getTime() + 600_000)

    const skipped = await runSweep(ctx, new Date(NOW.getTime() + 60_000), state)
    expect(skipped.skipped).toBe('rate limited')

    // Past the backoff it asks again, fails again, and stays quiet within the hour.
    await runSweep(ctx, new Date(NOW.getTime() + 700_000), state)
    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes('listing repositories')),
    ).toHaveLength(1)
  })
})

describe('ensureScheduler', () => {
  const SLOT = 'daedalusBuildSchedulerV2'
  const V1 = 'daedalusBuildSchedulerV1'
  const g = globalThis as unknown as Record<string, unknown>

  /** A scheduler as the previous version of the module left it running. */
  function plantV1(state: unknown) {
    const tick = vi.fn(async () => undefined)
    const handle = setInterval(() => {
      const v = g[V1] as { tick?: () => unknown } | undefined
      void v?.tick?.()
    }, 3_000)
    g[V1] = { handle, tick, state }
    return { tick, handle }
  }

  it('starts one interval, ticks at 30 s idle, and sweeps a minute after start', async () => {
    vi.useFakeTimers({ now: NOW })
    const spy = vi.spyOn(globalThis, 'setInterval')
    scheduler.ensureScheduler()
    scheduler.ensureScheduler()
    scheduler.ensureScheduler()
    expect(spy).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.calls.readStatus).toBe(1)
    await vi.advanceTimersByTimeAsync(27_000)
    expect(h.calls.readStatus).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.calls.readStatus).toBe(2)
    expect(h.calls.store).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.calls.store).toHaveLength(1)
    expect(h.calls.prune).toHaveLength(1)
  })

  it('ticks every 3 s while a build is in flight', async () => {
    vi.useFakeTimers({ now: NOW })
    h.active = [row({ state: 'building', startedAt: NOW, updatedAt: NOW })]
    setStatus(status())
    scheduler.ensureScheduler()
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.calls.readStatus).toBe(3)
  })

  it('skips a tick that overlaps a slow one, and takes over after 5 minutes', async () => {
    vi.useFakeTimers({ now: NOW })
    h.active = [row({ state: 'building', startedAt: NOW, updatedAt: NOW })]
    let release: () => void = () => undefined
    h.readStatusHook = () =>
      new Promise<void>((resolve) => {
        release = resolve
      })
    scheduler.ensureScheduler()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.calls.readStatus).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.calls.readStatus).toBe(1)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(h.calls.readStatus).toBe(2)
    h.readStatusHook = null
    release()
  })

  it('survives a re-evaluation without a second interval or a spin', async () => {
    vi.useFakeTimers({ now: NOW })
    const set = vi.spyOn(globalThis, 'setInterval')
    const clear = vi.spyOn(globalThis, 'clearInterval')
    scheduler.ensureScheduler()
    const first = g[SLOT] as { tick: unknown; state: unknown }

    vi.resetModules()
    const again = await import('./scheduler')
    const second = g[SLOT] as { tick: unknown; state: unknown }
    expect(second.tick).not.toBe(first.tick)
    expect(second.state).toBe(first.state)
    again.ensureScheduler()
    again.ensureScheduler()
    expect(set).toHaveBeenCalledTimes(2)
    expect(clear).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(h.calls.readStatus).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
    again.stopScheduler()
  })

  it('takes over a slot of another shape instead of trusting it', async () => {
    vi.useFakeTimers({ now: NOW })
    g[SLOT] = { handle: 'nonsense', tick: Promise.resolve(), state: { busy: Promise.resolve() } }
    scheduler.ensureScheduler()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.calls.readStatus).toBe(1)
  })

  it('does not start a scheduler from a bare module evaluation', async () => {
    vi.useFakeTimers({ now: NOW })
    vi.resetModules()
    await import('./scheduler')
    expect(g[SLOT]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retires the scheduler the previous key runs, carrying its state over in place', async () => {
    vi.useFakeTimers({ now: NOW })
    const { detectedSeen: _seen, ...v1State } = freshState(NOW.getTime())
    const planted: Rec = { ...v1State, pending: { id: ID, at: NOW.getTime() } }
    const old = plantV1(planted)
    const clear = vi.spyOn(globalThis, 'clearInterval')

    // What a Vite save does: the new module evaluates while the old interval runs.
    vi.resetModules()
    await import('./scheduler')
    expect(g[V1]).toBeUndefined()
    expect(clear).toHaveBeenCalledWith(old.handle)
    const slot = g[SLOT] as { state: unknown }
    expect(slot.state).toBe(planted)
    expect(planted).toMatchObject({ detectedSeen: null, pending: { id: ID } })

    await vi.advanceTimersByTimeAsync(9_000)
    expect(old.tick).not.toHaveBeenCalled()
    expect(h.calls.readStatus).toBeGreaterThan(0)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('starts afresh when the previous key held a state of another shape', async () => {
    vi.useFakeTimers({ now: NOW })
    plantV1({ busy: 'yes' })
    scheduler.ensureScheduler()
    expect(g[V1]).toBeUndefined()
    expect((g[SLOT] as { state: unknown }).state).toMatchObject({ busy: null, detectedSeen: null })
    expect(vi.getTimerCount()).toBe(1)
  })

  it('stops an old scheduler that comes back after the takeover, within a tick', async () => {
    vi.useFakeTimers({ now: NOW })
    scheduler.ensureScheduler()
    await vi.advanceTimersByTimeAsync(1_000)
    plantV1(freshState(NOW.getTime()))
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(g[V1]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(1)
  })
})
