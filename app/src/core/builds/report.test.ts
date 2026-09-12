import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuildRow } from '../../lib/build-queue'
import type { Ctx } from '../ctx'
import type { GhResult } from '../github-app'

// What GitHub hears about a build. GitHub (ghApp), the repositories, the log
// reader and the committed site.json are mocked; the store is an in-memory
// map behind the Ctx shape. Only Date is faked, so the throttles and the
// 30-minute clock can be walked without touching the promise queue.

type Call = { path: string; method: string; body: Record<string, unknown> }
type Deploy = {
  digest: string
  revision: string | null
  result: string
  httpCode: string | null
  startedAt: Date
}

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  answer: null as unknown as (path: string, method: string) => GhResult,
  throwIn: null as string | null,
  build: undefined as unknown,
  active: [] as unknown[],
  unreported: [] as unknown[],
  unreportedArgs: [] as unknown[][],
  latest: undefined as unknown,
  marks: [] as [string, unknown][],
  app: undefined as unknown,
  deploys: [] as unknown[],
  ingests: [] as [string, string][],
  log: { available: true, text: '', truncated: false, sizeBytes: 0 },
  site: undefined as unknown,
  store: new Map<string, unknown>(),
}))

const boom = (where: string) => {
  if (h.throwIn === where) throw new Error(`${where} exploded`)
}

vi.mock('../github-app', () => ({
  ghApp: async (_ctx: unknown, path: string, init: RequestInit = {}) => {
    boom('gh')
    const method = init.method ?? 'GET'
    h.calls.push({ path, method, body: JSON.parse(String(init.body ?? '{}')) })
    return h.answer(path, method)
  },
}))
vi.mock('../../lib/repo/builds', () => ({
  getBuild: async () => h.build,
  markReported: async (id: string, report: unknown) => {
    boom('mark')
    h.marks.push([id, report])
  },
  activeBuilds: async () => h.active,
  unreportedBuilds: async (...args: unknown[]) => {
    boom('unreported')
    h.unreportedArgs.push(args)
    return h.unreported
  },
  latestSucceeded: async () => h.latest,
  toBuildRow: (r: unknown) => r,
}))
vi.mock('../../lib/repo/apps', () => ({
  getApp: async () => {
    boom('app')
    return h.app
  },
}))
vi.mock('../../lib/repo/deployments', () => ({
  ingestDeployments: async (appId: string, name: string) => {
    h.ingests.push([appId, name])
  },
  listDeployments: async () => h.deploys,
}))
vi.mock('../../lib/build-bridge', () => ({ readBuildLogTail: async () => h.log }))
vi.mock('../../lib/contract/domains/site-doc', () => ({
  readCommittedSite: async () => {
    boom('site')
    return h.site
  },
}))
vi.mock('../../lib/contract/domains/site', () => ({
  siteIdentity: async () => ({ data: { controlPlane: { hostname: null } } }),
}))

const {
  CHECK_RUN_TEXT_MAX_BYTES,
  DEPLOY_WAIT_MS,
  REPORT_FAILURES_KEY,
  deliveryOf,
  fenceLog,
  matchDeploy,
  readReportFailures,
  reportBuildChange,
  reportTick,
  retryReport,
} = await import('./report')

const ID = '11111111-2222-4333-8444-555555555555'
const SHA = `abcdef0${'1'.repeat(33)}`
const DIGEST = `sha256:${'a'.repeat(64)}`
const T0 = Date.parse('2026-09-12T12:00:00Z')
const BUILD_URL = `https://daedalus-app.example.test/apps/iris/builds/${ID}`
const bytesOf = (s: string) => new TextEncoder().encode(s).length

const ctx = {
  env: () => undefined,
  store: {
    read: async (k: string, guard: (v: unknown) => boolean) => {
      const v = h.store.get(k)
      return guard(v) ? v : undefined
    },
    write: async (k: string, v: unknown) => {
      h.store.set(k, structuredClone(v))
    },
    delete: async (k: string) => {
      h.store.delete(k)
    },
  },
} as unknown as Ctx

function row(over: Partial<BuildRow> = {}): BuildRow {
  return {
    id: ID,
    appId: 'app-1',
    app: 'iris',
    lane: 'main',
    prNumber: null,
    sha: SHA,
    strategy: 'auto',
    resolvedStrategy: 'railpack',
    publish: 'live',
    requestedBy: 'webhook',
    actor: null,
    deliveryId: null,
    state: 'building',
    phase: 'building',
    error: null,
    detected: null,
    warnings: null,
    facts: null,
    checks: null,
    digest: null,
    imageRef: null,
    sizeBytes: null,
    timings: {},
    checkRunId: null,
    deploymentId: null,
    reported: false,
    createdAt: new Date(T0 - 5 * 60_000),
    startedAt: new Date(T0 - 4 * 60_000),
    updatedAt: new Date(T0),
    ...over,
  }
}

const succeeded = (over: Partial<BuildRow> = {}) =>
  row({
    state: 'succeeded',
    phase: 'published',
    checkRunId: 77,
    digest: DIGEST,
    imageRef: `registry.example.test/iris@${DIGEST}`,
    sizeBytes: 300 * 1024 * 1024,
    ...over,
  })

function res(status: number | null, body: unknown = null, retryAfterMs: number | null = null) {
  return {
    status,
    body,
    headers: new Headers(),
    retryAfterMs,
    error: status === null ? 'unreachable' : null,
  } as GhResult
}

const at = (ms: number) => vi.setSystemTime(T0 + ms)
const paths = () => h.calls.map((c) => `${c.method} ${c.path}`)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at(0)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  delete (globalThis as { daedalusBuildReportV1?: unknown }).daedalusBuildReportV1
  Object.assign(h, {
    calls: [],
    throwIn: null,
    build: undefined,
    active: [],
    unreported: [],
    latest: undefined,
    marks: [],
    deploys: [],
    ingests: [],
    log: { available: true, text: 'step 1\nstep 2\n', truncated: false, sizeBytes: 14 },
    store: new Map(),
    app: {
      id: 'app-1',
      name: 'iris',
      hostname: 'iris.example.test',
      stage: 'live',
      deployEnable: true,
      sourceMode: 'registry',
      image: null,
    },
    site: {
      present: true,
      doc: {
        identity: {
          hostname: 's2-server',
          baseDomain: 'example.test',
          controlPlane: 'daedalus-app',
        },
        github: {
          app: { id: 1, slug: 'x', clientId: 'c', htmlUrl: 'h', owner: 'octo', ownerId: 9 },
        },
      },
    },
  })
  h.answer = (path, method) => {
    if (method === 'POST' && path.endsWith('/check-runs')) return res(201, { id: 77 })
    if (method === 'PATCH' && path.includes('/check-runs/')) return res(200, { id: 77 })
    if (method === 'POST' && path.endsWith('/deployments')) return res(201, { id: 555 })
    if (method === 'POST' && path.endsWith('/statuses')) return res(201, { id: 1 })
    return res(404)
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the check run', () => {
  it('is created once the build is past queued, with Details on the build page', async () => {
    await reportBuildChange(ctx, row({ state: 'queued', phase: '' }))
    expect(h.calls).toEqual([])

    await reportBuildChange(ctx, row({ state: 'cloning', phase: 'requested' }))
    expect(paths()).toEqual(['POST /repos/octo/iris/check-runs'])
    const body = h.calls[0]?.body as Record<string, unknown> & {
      output: { title: string; summary: string }
    }
    expect(body).toMatchObject({
      name: 'daedalus',
      head_sha: SHA,
      status: 'in_progress',
      external_id: ID,
      details_url: BUILD_URL,
      started_at: '2026-09-12T11:56:00Z',
    })
    expect(body.output.title).toBe('Building on s2-server — requested')
    expect(body.output.summary).toContain('Strategy: railpack (auto)')
    expect(body.output).not.toHaveProperty('text')
    expect(h.marks).toEqual([[ID, { checkRunId: 77 }]])
  })

  it('is not created twice when the database already holds one', async () => {
    h.build = row({ checkRunId: 99 })
    await reportBuildChange(ctx, row({ state: 'detecting', phase: 'detecting' }))
    expect(paths()).toEqual(['PATCH /repos/octo/iris/check-runs/99'])
  })

  it('PATCHes phase changes at most every 10 s, and a tick sends the one held back', async () => {
    const r = (phase: string) => row({ state: 'checking', phase, checkRunId: 77 })
    await reportBuildChange(ctx, r('lint'))
    expect(h.calls).toHaveLength(1)

    at(1_000)
    await reportBuildChange(ctx, r('lint'))
    at(3_000)
    await reportBuildChange(ctx, r('typecheck'))
    expect(h.calls).toHaveLength(1)

    at(11_000)
    h.active = [r('typecheck')]
    await reportTick(ctx)
    expect(h.calls).toHaveLength(2)
    expect(h.calls[1]?.body).toMatchObject({
      status: 'in_progress',
      output: { title: 'Building on s2-server — typecheck' },
    })

    at(30_000)
    await reportTick(ctx)
    expect(h.calls).toHaveLength(2)
  })

  it('completes with the story and the log in a fence no backtick run can close', async () => {
    h.log = {
      available: true,
      text: 'pnpm lint\n```js\nconst a = 1\n````\nlint failed\n',
      truncated: false,
      sizeBytes: 40,
    }
    await reportBuildChange(
      ctx,
      row({
        state: 'failed',
        phase: 'checking',
        error: 'checking',
        checkRunId: 77,
        checks: { ran: ['format:check', 'lint'], failed: 'lint' },
        timings: { cloning: 1_200, checking: 5_000 },
        warnings: [{ code: 'railpack', message: 'Railpack says pin Node' }],
        detected: {
          info: {
            success: true,
            railpackVersion: '0.39.0',
            detectedProviders: ['node'],
            metadata: { nodeRuntime: 'tanstack-start' },
            resolvedPackages: {
              node: {
                requestedVersion: '24.18.1',
                resolvedVersion: '24.18.1',
                source: '.tool-versions',
              },
            },
            logs: [],
          },
          plan: { deploy: { startCommand: 'node start.mjs' } },
        },
      }),
    )
    expect(paths()).toEqual(['PATCH /repos/octo/iris/check-runs/77'])
    const body = h.calls[0]?.body as {
      conclusion: string
      completed_at: string
      output: { title: string; summary: string; text: string }
    }
    expect(body.conclusion).toBe('failure')
    expect(body.completed_at).toBe('2026-09-12T12:00:00Z')
    expect(body.output.title).toBe('Build failed on s2-server: checking')
    const s = body.output.summary
    expect(s).toContain('Checks: `format:check`, `lint`; failed: `lint`')
    expect(s).toContain('Timings: cloning 1.2 s · checking 5.0 s · total 6.2 s')
    expect(s).toContain(
      'Detected: node · tanstack-start · Node 24.18.1 (.tool-versions) · start `node start.mjs` · Railpack 0.39.0',
    )
    expect(s).toContain('- Railpack says pin Node')
    expect(body.output.text.startsWith('`````\npnpm lint\n')).toBe(true)
    expect(body.output.text.endsWith('lint failed\n`````')).toBe(true)
    expect(h.marks).toEqual([[ID, { reported: true }]])
  })

  it('cancelled and superseded builds conclude cancelled', async () => {
    await reportBuildChange(
      ctx,
      row({ state: 'superseded', phase: 'superseded by 1234567', checkRunId: 77 }),
    )
    expect(h.calls[0]?.body).toMatchObject({
      conclusion: 'cancelled',
      output: { title: 'Superseded by 1234567' },
    })
  })

  it('a build that never started and never posted is marked reported without GitHub', async () => {
    await reportBuildChange(
      ctx,
      row({ state: 'superseded', phase: 'superseded by x', startedAt: null }),
    )
    expect(h.calls).toEqual([])
    expect(h.marks).toEqual([[ID, { reported: true }]])
  })

  it('sends nothing when site.json names no App', async () => {
    ;(h.site as { doc: { github: unknown } }).doc.github = { app: null }
    await reportBuildChange(ctx, row({ state: 'cloning' }))
    expect(h.calls).toEqual([])
  })
})

describe('list rows', () => {
  it('complete the check run with what the whole build holds', async () => {
    h.build = row({
      state: 'failed',
      phase: 'checking',
      error: 'check failed: lint',
      checkRunId: 77,
      checks: { ran: ['lint'], failed: 'lint' },
      timings: { checking: 5_000 },
      warnings: [{ code: 'railpack', message: 'Railpack says pin Node' }],
    })
    // What the scheduler hands over: a list row, with none of the four.
    await reportBuildChange(
      ctx,
      row({ state: 'failed', phase: 'checking', error: 'check failed: lint', checkRunId: 77 }),
    )
    const body = h.calls[0]?.body as { output?: { summary?: string } } | undefined
    const s = body?.output?.summary ?? ''
    expect(s).toContain('Checks: `lint`; failed: `lint`')
    expect(s).toContain('Timings: checking 5.0 s')
    expect(s).toContain('- Railpack says pin Node')
  })

  it('the tick reads unreported builds of the last 24 hours, twenty at most', async () => {
    h.unreportedArgs = []
    await reportTick(ctx)
    const [since, limit] = (h.unreportedArgs[0] ?? []) as [Date, number]
    expect(since.getTime()).toBe(T0 - 24 * 60 * 60_000)
    expect(limit).toBe(20)
  })
})

describe("GitHub's byte limits", () => {
  it('keeps summary and text inside them however large the build says', async () => {
    const glyphs = '█▓▒░ build output with glyphs ✓\n'
    h.log = { available: true, text: glyphs.repeat(8_000), truncated: true, sizeBytes: 1 }
    await reportBuildChange(
      ctx,
      row({
        state: 'failed',
        error: 'building',
        checkRunId: 77,
        warnings: Array.from({ length: 2_000 }, () => ({
          code: 'railpack' as const,
          message: '✗'.repeat(100),
        })),
      }),
    )
    const out = (h.calls[0]?.body as { output: { summary: string; text: string } } | undefined)
      ?.output ?? { summary: '', text: '' }
    expect(bytesOf(out.summary)).toBeLessThanOrEqual(60_000)
    expect(out.summary.endsWith('… truncated')).toBe(true)
    expect(bytesOf(out.text)).toBeLessThanOrEqual(CHECK_RUN_TEXT_MAX_BYTES)
    expect(out.text.endsWith('✓\n```')).toBe(true)
  })

  it('fenceLog outgrows any backtick run and still fits', () => {
    expect(fenceLog('a\n``\nb')).toBe('```\na\n``\nb\n```')
    expect(fenceLog('x ```` y\n')).toBe('`````\nx ```` y\n`````')

    const run = '`'.repeat(3_000)
    const huge = `${'filler line ░\n'.repeat(3_900)}${run}\nthe end`
    const block = fenceLog(huge)
    expect(bytesOf(block)).toBeLessThanOrEqual(CHECK_RUN_TEXT_MAX_BYTES)
    const fence = block.slice(0, block.indexOf('\n'))
    expect(fence).toBe('`'.repeat(3_001))
    expect(block.endsWith(`the end\n${fence}`)).toBe(true)
  })
})

describe('the Deployment', () => {
  it('a live build of a deployable app gets one, in progress, and stays unreported', async () => {
    await reportBuildChange(ctx, succeeded())
    expect(paths()).toEqual([
      'PATCH /repos/octo/iris/check-runs/77',
      'POST /repos/octo/iris/deployments',
      'POST /repos/octo/iris/deployments/555/statuses',
    ])
    const check = h.calls[0]?.body as {
      conclusion: string
      output: { title: string; summary: string }
    }
    expect(check.conclusion).toBe('success')
    expect(check.output.title).toBe('Built on s2-server')
    expect(check.output.summary).toContain('Result: built, deploying')
    expect(check.output.summary).toContain(`Tags (expected): \`sha-${SHA}\`, \`latest\``)
    expect(check.output.summary).toContain('Pull size: 300 MB')
    expect(h.calls[1]?.body).toEqual({
      ref: SHA,
      environment: 'production',
      required_contexts: [],
      auto_merge: false,
      transient_environment: false,
      production_environment: true,
      description: 'Built on s2-server',
      payload: { buildId: ID },
    })
    expect(h.calls[2]?.body).toMatchObject({ state: 'in_progress', log_url: BUILD_URL })
    expect(h.marks).toEqual([[ID, { deploymentId: 555 }]])
  })

  it.each([
    ['candidate', { publish: 'candidate' as const }, {}],
    ['pinned', {}, { deployEnable: false }],
  ])('a %s build gets none', async (kind, over, appOver) => {
    Object.assign(h.app as object, appOver)
    await reportBuildChange(ctx, succeeded(over))
    expect(paths()).toEqual(['PATCH /repos/octo/iris/check-runs/77'])
    const out = (h.calls[0]?.body as { output: { title: string; summary: string } } | undefined)
      ?.output ?? { title: '', summary: '' }
    expect(out.title).toBe(`Built on s2-server, not deployed (${kind})`)
    expect(out.summary).toContain(`Result: built, not deployed (${kind})`)
    expect(h.marks).toEqual([[ID, { reported: true }]])
  })

  it('deliveryOf: frozen, local and digest-pinned apps are pinned', () => {
    const app = h.app as Parameters<typeof deliveryOf>[1] & object
    expect(deliveryOf({ publish: 'live' }, app)).toBe('deploy')
    expect(deliveryOf({ publish: 'live' }, { ...app, sourceMode: 'local' })).toBe('pinned')
    expect(deliveryOf({ publish: 'live' }, { ...app, image: `r/iris@${DIGEST}` })).toBe('pinned')
    expect(deliveryOf({ publish: 'live' }, null)).toBe('pinned')
    expect(deliveryOf({ publish: 'candidate' }, app)).toBe('candidate')
  })
})

describe('matching the deploy', () => {
  const waiting = () => succeeded({ deploymentId: 555 })
  const deploy = (over: Partial<Deploy>): Deploy => ({
    digest: DIGEST,
    revision: null,
    result: 'ok',
    httpCode: '200',
    startedAt: new Date(T0 + 2 * 60_000),
    ...over,
  })

  it('on the pushed digest: success with the app and build URLs', async () => {
    at(3 * 60_000)
    h.unreported = [waiting()]
    h.deploys = [deploy({})]
    await reportTick(ctx)
    expect(h.ingests).toEqual([['app-1', 'iris']])
    expect(paths()).toEqual(['POST /repos/octo/iris/deployments/555/statuses'])
    expect(h.calls[0]?.body).toEqual({
      state: 'success',
      description: 'Deployed and answering (HTTP 200).',
      environment_url: 'https://iris.example.test',
      log_url: BUILD_URL,
    })
    expect(h.marks).toEqual([[ID, { reported: true }]])
  })

  it('falls back to the revision, and a failed health check is a failure', async () => {
    at(3 * 60_000)
    h.deploys = [
      deploy({
        digest: `sha256:${'b'.repeat(64)}`,
        revision: SHA,
        result: 'failed',
        httpCode: '502',
      }),
    ]
    await reportBuildChange(ctx, waiting())
    expect(h.calls[0]?.body).toMatchObject({
      state: 'failure',
      environment_url: 'https://iris.example.test',
    })
    expect(String(h.calls[0]?.body.description)).toContain('HTTP 502')
  })

  it('matchDeploy prefers the digest and ignores deploys from before the build', () => {
    const b = waiting()
    const byRevision = deploy({
      digest: 'sha256:other',
      revision: SHA,
      startedAt: new Date(T0 + 9e5),
    })
    const byDigest = deploy({})
    const older = deploy({ startedAt: new Date(T0 - 60 * 60_000) })
    expect(matchDeploy([byRevision, byDigest], b)).toBe(byDigest)
    expect(matchDeploy([byRevision], b)).toBe(byRevision)
    expect(matchDeploy([older], b)).toBeNull()
  })

  it('30 minutes without a deploy is an error', async () => {
    at(DEPLOY_WAIT_MS - 60_000)
    await reportBuildChange(ctx, waiting())
    expect(h.calls).toEqual([])
    expect(h.marks).toEqual([])

    at(DEPLOY_WAIT_MS + 60_000)
    await reportBuildChange(ctx, waiting())
    expect(h.calls[0]?.body).toEqual({
      state: 'error',
      description: 'No deploy landed within 30 minutes of the build.',
      log_url: BUILD_URL,
    })
    expect(h.marks).toEqual([[ID, { reported: true }]])
  })

  it('a newer build deploying first makes this one inactive', async () => {
    const NEWER = `9876543${'2'.repeat(33)}`
    const newerDigest = `sha256:${'c'.repeat(64)}`
    h.latest = succeeded({ id: 'newer', sha: NEWER, digest: newerDigest, createdAt: new Date(T0) })
    h.deploys = [deploy({ digest: newerDigest })]
    at(3 * 60_000)
    await reportBuildChange(ctx, waiting())
    expect(h.calls[0]?.body).toMatchObject({
      state: 'inactive',
      description: 'Build 9876543 deployed before this one did.',
    })
  })
})

describe('failures', () => {
  it('a rate limit stops every call until retry-after, and spends no retries', async () => {
    h.answer = () => res(429, null, 60_000)
    await reportBuildChange(ctx, row({ state: 'cloning' }))
    expect(h.calls).toHaveLength(1)
    expect(h.store.has(REPORT_FAILURES_KEY)).toBe(false)

    h.answer = () => res(201, { id: 77 })
    at(30_000)
    await reportBuildChange(ctx, row({ state: 'cloning' }))
    h.unreported = [row({ state: 'failed', id: 'other-build' })]
    await reportTick(ctx)
    expect(h.calls).toHaveLength(1)

    at(61_000)
    await reportBuildChange(ctx, row({ state: 'cloning' }))
    expect(h.calls).toHaveLength(2)
  })

  it('retries 3 times on a widening delay, records the failure, then waits for Retry report', async () => {
    h.answer = () => res(502)
    const failed = row({ state: 'failed', error: 'building' })
    h.unreported = [failed]
    const tickAt = async (ms: number) => {
      at(ms)
      await reportTick(ctx)
    }

    await tickAt(0)
    expect(h.calls).toHaveLength(1)
    await tickAt(10_000)
    expect(h.calls).toHaveLength(1)
    await tickAt(31_000)
    expect(h.calls).toHaveLength(2)
    await tickAt(152_000)
    expect(h.calls).toHaveLength(3)
    await tickAt(753_000)
    expect(h.calls).toHaveLength(4)
    await tickAt(3 * 60 * 60_000)
    expect(h.calls).toHaveLength(4)

    expect(h.store.get(REPORT_FAILURES_KEY)).toEqual({
      [ID]: expect.objectContaining({
        step: 'check-run',
        kind: 'server',
        status: 502,
        attempts: 4,
        gaveUp: true,
      }),
    })
    expect(await readReportFailures(ctx)).toHaveProperty(ID)
    expect(h.marks).toEqual([])
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1)

    h.answer = () => res(201, { id: 77 })
    h.build = failed
    await retryReport(ctx, ID)
    expect(h.calls).toHaveLength(5)
    expect(h.store.has(REPORT_FAILURES_KEY)).toBe(false)
    expect(h.marks).toEqual([
      [ID, { checkRunId: 77 }],
      [ID, { reported: true }],
    ])
  })

  it('a Deployment GitHub refuses (409) is recorded as a conflict', async () => {
    h.answer = (path, method) =>
      method === 'POST' && path.endsWith('/deployments')
        ? res(409, { message: 'Conflict' })
        : res(200, { id: 77 })
    await reportBuildChange(ctx, succeeded())
    expect(h.store.get(REPORT_FAILURES_KEY)).toEqual({
      [ID]: expect.objectContaining({
        step: 'deployment',
        kind: 'conflict',
        attempts: 1,
        gaveUp: false,
      }),
    })
    expect(h.marks).toEqual([])
  })

  it.each(['gh', 'app', 'mark', 'site'])('never throws when %s does', async (where) => {
    h.throwIn = where
    await expect(reportBuildChange(ctx, succeeded())).resolves.toBeUndefined()
    await expect(reportBuildChange(ctx, row({ state: 'cloning' }))).resolves.toBeUndefined()
    h.unreported = [succeeded()]
    await expect(reportTick(ctx)).resolves.toBeUndefined()
    await expect(retryReport(ctx, ID)).resolves.toBeUndefined()
  })

  it('never throws when the tick cannot read the builds', async () => {
    h.throwIn = 'unreported'
    await expect(reportTick(ctx)).resolves.toBeUndefined()
  })
})

describe('the per-process memo', () => {
  const KEY = 'daedalusBuildReportV1'
  const g = globalThis as unknown as Record<string, unknown>
  const wellFormed = () => ({
    blockedUntil: 0,
    lastTickAt: 0,
    sent: new Map(),
    checkRuns: new Map(),
    deployments: new Map(),
    completed: new Map(),
    failures: null,
    logged: new Set(),
    inFlight: new Set(),
    ingestedAt: new Map(),
  })

  it.each([
    ['a Map turned into a Set', { ...wellFormed(), sent: new Set() }],
    ['a renamed field', { ...wellFormed(), blockedUntil: undefined, rateLimitedUntil: 0 }],
    ['a missing field', { ...wellFormed(), inFlight: undefined }],
    ['a non-finite clock', { ...wellFormed(), blockedUntil: Number.NaN }],
    [
      'a failure entry from an older shape',
      { ...wellFormed(), failures: new Map([[ID, { kind: 'server', attempts: 9 }]]) },
    ],
    ['a sent entry from an older shape', { ...wellFormed(), sent: new Map([[ID, 12]]) }],
    ['not an object', 'stale'],
  ])('replaces %s, and both entry points keep working', async (_what, planted) => {
    g[KEY] = planted
    await expect(reportBuildChange(ctx, row({ state: 'cloning' }))).resolves.toBeUndefined()
    expect(paths()).toEqual(['POST /repos/octo/iris/check-runs'])
    expect(g[KEY]).not.toBe(planted)
    expect(g[KEY]).toMatchObject({ sent: expect.any(Map), inFlight: expect.any(Set) })

    g[KEY] = planted
    at(60_000)
    h.unreported = [row({ state: 'failed', error: 'building', checkRunId: 77 })]
    await expect(reportTick(ctx)).resolves.toBeUndefined()
    expect(paths()).toContain('PATCH /repos/octo/iris/check-runs/77')
    expect(g[KEY]).not.toBe(planted)
  })

  it('keeps a well-formed memo, and what it holds still applies', async () => {
    const planted = { ...wellFormed(), blockedUntil: T0 + 60_000 }
    g[KEY] = planted
    await reportBuildChange(ctx, row({ state: 'cloning' }))
    expect(h.calls).toEqual([])
    expect(g[KEY]).toBe(planted)
  })

  it('the failure record has its SETTING_KEYS entry', async () => {
    const { SETTING_KEYS } = await import('../../lib/repo/settings')
    expect(SETTING_KEYS.buildsReportFailures).toBe(REPORT_FAILURES_KEY)
  })
})
