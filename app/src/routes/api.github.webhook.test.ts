import { createHmac } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The webhook route. Everything past the signature is mocked at the module
// boundary: the transaction, the delivery and build repositories, the app
// lookup and the App's identity/installation. The transaction is a copy of
// the stores that replaces them only when its callback returns, so "commits
// together" and "rolls back together" are both observable.

type DeliveryRow = { id: string; event: string; action: string | null; outcome: string }
type BuildRow = {
  id: string
  appId: string
  lane: string
  sha: string
  state: string
  publish: string
  [k: string]: unknown
}
type AppRow = {
  id: string
  name: string
  githubRepoId: number | null
  buildOnBox: boolean
  managedInNix: boolean
  sourceMode: string
  buildStrategy: string
  buildPublish: string
}
type FakeTx = { deliveries: Map<string, DeliveryRow>; builds: BuildRow[] }

const h = vi.hoisted(() => ({
  deliveries: new Map<string, DeliveryRow>(),
  builds: [] as BuildRow[],
  apps: [] as AppRow[],
  identity: null as { ownerId: number } | null,
  installationId: null as number | null,
  refreshes: 0,
  enqueueError: null as Error | null,
  txs: [] as FakeTx[],
  enqueueExecs: [] as unknown[],
  seq: 0,
}))

vi.mock('../lib/db', () => ({
  withTransaction: async <T>(fn: (tx: FakeTx) => Promise<T>): Promise<T> => {
    const tx: FakeTx = {
      deliveries: new Map(h.deliveries),
      builds: h.builds.map((b) => ({ ...b })),
    }
    h.txs.push(tx)
    const result = await fn(tx)
    h.deliveries = tx.deliveries
    h.builds = tx.builds
    return result
  },
}))
vi.mock('../lib/repo/github-deliveries', () => ({
  recordDelivery: async (
    tx: FakeTx,
    d: { id: string; event: string; action?: string | null; outcome: string },
  ) => {
    if (tx.deliveries.has(d.id)) return false
    tx.deliveries.set(d.id, {
      id: d.id,
      event: d.event,
      action: d.action ?? null,
      outcome: d.outcome,
    })
    return true
  },
  setDeliveryOutcome: async (tx: FakeTx, id: string, outcome: string) => {
    const row = tx.deliveries.get(id)
    if (row) tx.deliveries.set(id, { ...row, outcome })
  },
}))
vi.mock('../lib/repo/builds', () => ({
  insertOrSupersedeQueued: async (
    input: { appId: string; lane?: string; sha: string; publish?: string } & Record<
      string,
      unknown
    >,
    exec: FakeTx,
  ) => {
    h.enqueueExecs.push(exec)
    if (h.enqueueError) throw h.enqueueError
    const lane = input.lane ?? 'main'
    const inLane = (b: BuildRow) =>
      b.appId === input.appId && b.lane === lane && b.state === 'queued'
    const waiting = exec.builds.find(inLane)
    if (waiting?.sha === input.sha) return { row: waiting, superseded: [], alreadyQueued: true }
    const superseded = exec.builds.filter(inLane)
    for (const b of superseded) b.state = 'superseded'
    h.seq++
    const row: BuildRow = {
      ...input,
      id: `build-${String(h.seq)}`,
      lane,
      publish: input.publish ?? 'live',
      state: 'queued',
    }
    exec.builds.push(row)
    return { row, superseded, alreadyQueued: false }
  },
  activeBuilds: async () =>
    h.builds.filter((b) =>
      ['cloning', 'detecting', 'checking', 'building', 'publishing'].includes(b.state),
    ),
  latestSucceeded: async (appId: string, lane: string, publish: string) =>
    [...h.builds]
      .reverse()
      .find(
        (b) =>
          b.appId === appId && b.lane === lane && b.state === 'succeeded' && b.publish === publish,
      ),
}))
vi.mock('../lib/repo/apps', () => ({
  listApps: async () => h.apps,
}))
// The id-first, name-fallback rule itself is lib/repo/app-lookup.test.ts's.
vi.mock('../lib/repo/app-lookup', () => ({
  appForRepository: async (repoId: number, repoName: string) =>
    h.apps.find((a) => a.githubRepoId === repoId) ??
    h.apps.find((a) => a.name === repoName.toLowerCase()),
}))
vi.mock('../core/github-app', () => ({
  appIdentity: async () => h.identity,
  installationState: async () => ({
    available: h.installationId !== null,
    data: { installationId: h.installationId },
  }),
  requestTokenRefresh: async () => {
    h.refreshes++
    return true
  },
}))

const { handleGithubWebhook, MAX_BODY_BYTES } = await import('./api.github.webhook')
type WebhookDeps = import('./api.github.webhook').WebhookDeps

const URL_ = 'http://app-daedalus:3000/api/github/webhook'
const SECRET = 'whsec-7f3a9c1e5b2d8046'
const MiB = 1024 * 1024
const DELIVERY = '72d3162e-cc78-11e3-81ab-4c9367dc0958'
const OWNER_ID = 29_045_597
const INSTALLATION_ID = 161_050_778
const REPO_ID = 812_004_117
const SHA = '3f786850e387550fdab836ed7e6dc881de23001b'
const OLDER_SHA = '89e6c98d92887913cadf06b2adb97f26cde4849b'

let dir: string
let clock: number
let deps: WebhookDeps
let ids: number

const sign = (body: string | Uint8Array, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

const writeSecret = (value: string) => writeFile(join(dir, 'webhook-secret'), value)

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

/** A signed delivery. Each call gets a fresh delivery id unless one is given. */
function delivery(
  event: string,
  body: string,
  opts: { secret?: string; id?: string } = {},
): Request {
  ids++
  const id = opts.id ?? `72d3162e-cc78-11e3-81ab-${ids.toString(16).padStart(12, '0')}`
  return post(body, {
    'x-github-event': event,
    'x-github-delivery': id,
    'x-hub-signature-256': sign(body, opts.secret),
  })
}

function pushBody(
  over: {
    ref?: string
    after?: string
    fork?: boolean
    repoId?: number
    name?: string
    sender?: string
  } = {},
): string {
  const after = over.after ?? SHA
  return JSON.stringify({
    ref: over.ref ?? 'refs/heads/main',
    before: OLDER_SHA,
    after,
    deleted: false,
    forced: false,
    repository: {
      id: over.repoId ?? REPO_ID,
      name: over.name ?? 'Iris',
      full_name: `santiagotoscanini/${over.name ?? 'Iris'}`,
      default_branch: 'main',
      fork: over.fork ?? false,
      owner: { id: OWNER_ID, login: 'santiagotoscanini' },
    },
    installation: { id: INSTALLATION_ID },
    head_commit: { id: after, message: 'marker-do-not-log-me', author: { name: 'Santiago' } },
    sender: { login: over.sender ?? 'santiagotoscanini' },
  })
}

const iris = (over: Partial<AppRow> = {}): AppRow => ({
  id: 'app-iris',
  name: 'iris',
  githubRepoId: REPO_ID,
  buildOnBox: true,
  managedInNix: false,
  sourceMode: 'registry',
  buildStrategy: 'dockerfile',
  buildPublish: 'live',
  ...over,
})

/** A pushed build row, as insertOrSupersedeQueued would hold it. */
const existingBuild = (over: Partial<BuildRow>): BuildRow => ({
  id: 'build-old',
  appId: 'app-iris',
  lane: 'main',
  sha: OLDER_SHA,
  state: 'queued',
  publish: 'live',
  ...over,
})

function streamed(chunks: number) {
  const state = { pulled: 0 }
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled === chunks) {
        controller.close()
        return
      }
      state.pulled++
      controller.enqueue(new Uint8Array(MiB).fill(0x61))
    },
  })
  return { stream, state }
}

const logged = () =>
  [console.info, console.warn, console.error]
    .flatMap((f) => vi.mocked(f).mock.calls.flat())
    .join('\n')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-webhook-'))
  clock = 1_000_000
  ids = 0
  // Only env is read here; the rest of Ctx reaches the mocked core/github-app.
  deps = {
    env: (name: string) => (name === 'GITHUB_APP_DIR' ? dir : undefined),
    now: () => clock,
  } as unknown as WebhookDeps
  h.deliveries = new Map()
  h.builds = []
  h.apps = [iris()]
  h.identity = { ownerId: OWNER_ID }
  h.installationId = INSTALLATION_ID
  h.refreshes = 0
  h.enqueueError = null
  h.txs = []
  h.enqueueExecs = []
  h.seq = 0
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('handleGithubWebhook: the signed door', () => {
  it('answers 405 to anything but POST, secret or not', async () => {
    const res = await handleGithubWebhook(new Request(URL_), deps)
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('answers 503 without a secret file', async () => {
    const res = await handleGithubWebhook(delivery('ping', '{}'), deps)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'github app not configured' })
  })

  it.each([
    ['empty', ''],
    ['a trailing newline', `${SECRET}\n`],
    ['leading whitespace', ` ${SECRET}`],
  ])('answers 503 when the secret file holds %s', async (_label, value) => {
    await writeSecret(value)
    const res = await handleGithubWebhook(delivery('ping', '{}'), deps)
    expect(res.status).toBe(503)
  })

  it('does not remember a missing secret', async () => {
    expect((await handleGithubWebhook(delivery('ping', '{}'), deps)).status).toBe(503)
    await writeSecret(SECRET)
    expect((await handleGithubWebhook(delivery('ping', '{}'), deps)).status).toBe(200)
  })

  it('picks up a rotated secret once the cache has aged out', async () => {
    await writeSecret(SECRET)
    expect((await handleGithubWebhook(delivery('ping', '{}'), deps)).status).toBe(200)
    await writeSecret('whsec-rotated-0b91')
    clock += 61_000
    const res = await handleGithubWebhook(
      delivery('ping', '{}', { secret: 'whsec-rotated-0b91' }),
      deps,
    )
    expect(res.status).toBe(200)
  })

  it('answers 413 on a declared length over the cap without reading the body', async () => {
    await writeSecret(SECRET)
    const { stream, state } = streamed(1)
    const req = new Request(URL_, {
      method: 'POST',
      headers: { 'content-length': String(MAX_BODY_BYTES + 1) },
      body: stream,
      duplex: 'half',
    } as RequestInit)
    const res = await handleGithubWebhook(req, deps)
    expect(res.status).toBe(413)
    expect(state.pulled).toBeLessThanOrEqual(1)
  })

  it('answers 413 while streaming a body with no content-length past the cap', async () => {
    await writeSecret(SECRET)
    const { stream, state } = streamed(10)
    const req = new Request(URL_, { method: 'POST', body: stream, duplex: 'half' } as RequestInit)
    expect(req.headers.get('content-length')).toBeNull()
    const res = await handleGithubWebhook(req, deps)
    expect(res.status).toBe(413)
    expect(state.pulled).toBeLessThan(10)
  })

  it('answers 401 to a wrong signature, logging the delivery id and never the body', async () => {
    await writeSecret(SECRET)
    const res = await handleGithubWebhook(
      delivery('push', pushBody(), { secret: 'someone-elses-secret', id: DELIVERY }),
      deps,
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'bad signature' })
    expect(logged()).toContain(DELIVERY)
    expect(logged()).toContain('push')
    expect(logged()).not.toContain('marker-do-not-log-me')
    expect(logged()).not.toContain('sha256=')
    expect(h.txs).toHaveLength(0)
  })

  it('answers 401 to a missing signature header', async () => {
    await writeSecret(SECRET)
    const res = await handleGithubWebhook(post('{}', { 'x-github-event': 'ping' }), deps)
    expect(res.status).toBe(401)
  })
})

describe('handleGithubWebhook: a verified delivery', () => {
  beforeEach(() => writeSecret(SECRET))

  it.each([
    ['not JSON', '{"ref":'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
  ])('answers 400 to a body that is %s, recording nothing', async (_label, body) => {
    const res = await handleGithubWebhook(delivery('push', body), deps)
    expect(res.status).toBe(400)
    expect(h.txs).toHaveLength(0)
  })

  it.each([
    ['missing', undefined],
    ['not a GUID', 'x'.repeat(36)],
    ['a path', '../../etc/passwd'],
  ])('answers 400 when the delivery id is %s', async (_label, id) => {
    const body = '{"zen":"Design for failure."}'
    const headers: Record<string, string> = {
      'x-github-event': 'ping',
      'x-hub-signature-256': sign(body),
    }
    if (id !== undefined) headers['x-github-delivery'] = id
    const res = await handleGithubWebhook(post(body, headers), deps)
    expect(res.status).toBe(400)
    expect(h.txs).toHaveLength(0)
  })

  it('answers pong to a ping and records it', async () => {
    const res = await handleGithubWebhook(
      delivery('ping', '{"zen":"Keep it logically awesome."}', { id: DELIVERY }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'pong' })
    expect(h.deliveries.get(DELIVERY)).toEqual({
      id: DELIVERY,
      event: 'ping',
      action: null,
      outcome: 'pong',
    })
  })

  it('ignores a redelivered id and does nothing else', async () => {
    const body = JSON.stringify({ action: 'created', installation: { id: INSTALLATION_ID } })
    const first = await handleGithubWebhook(delivery('installation', body, { id: DELIVERY }), deps)
    expect(await first.json()).toEqual({ status: 'noted' })
    expect(h.refreshes).toBe(1)

    const again = await handleGithubWebhook(delivery('installation', body, { id: DELIVERY }), deps)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ status: 'ignored', reason: 'duplicate' })
    expect(h.refreshes).toBe(1)
    expect(h.deliveries.get(DELIVERY)?.outcome).toBe('noted')
  })

  it('does not queue a redelivered push twice', async () => {
    const first = await handleGithubWebhook(delivery('push', pushBody(), { id: DELIVERY }), deps)
    expect((await first.json()).status).toBe('queued')
    const again = await handleGithubWebhook(delivery('push', pushBody(), { id: DELIVERY }), deps)
    expect(await again.json()).toEqual({ status: 'ignored', reason: 'duplicate' })
    expect(h.builds).toHaveLength(1)
    expect(h.enqueueExecs).toHaveLength(1)
  })

  it.each([
    ['installation', { action: 'created' }],
    ['installation', { action: 'deleted' }],
    ['installation_repositories', { action: 'added' }],
    ['repository', { action: 'created', repository: { id: 1 } }],
  ])('asks for a token refresh on %s %o', async (event, body) => {
    const res = await handleGithubWebhook(
      delivery(event, JSON.stringify(body), { id: DELIVERY }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'noted' })
    expect(h.refreshes).toBe(1)
    expect(h.deliveries.get(DELIVERY)).toMatchObject({
      event,
      action: body.action,
      outcome: 'noted',
    })
  })

  it.each(['renamed', 'transferred', 'deleted'])(
    'logs the apps pinned to a %s repository and keeps the pin',
    async (action) => {
      h.apps = [iris(), iris({ id: 'app-hermes', name: 'hermes', githubRepoId: 5 })]
      const body = JSON.stringify({ action, repository: { id: REPO_ID, name: 'iris-renamed' } })
      const res = await handleGithubWebhook(delivery('repository', body), deps)
      expect(await res.json()).toEqual({ status: 'noted' })
      const warned = vi.mocked(console.warn).mock.calls.flat().join('\n')
      expect(warned).toContain('iris')
      expect(warned).toContain(action)
      expect(warned).not.toContain('hermes')
      expect(warned).not.toContain('iris-renamed')
      expect(h.apps[0]?.githubRepoId).toBe(REPO_ID)
    },
  )

  it('tells the operator a renamed repo still builds its pinned app', async () => {
    const body = JSON.stringify({
      action: 'renamed',
      repository: { id: REPO_ID, name: 'iris-web' },
    })
    await handleGithubWebhook(delivery('repository', body), deps)
    const warned = vi.mocked(console.warn).mock.calls.flat().join('\n')
    expect(warned).toContain('pushes still build iris')
    expect(warned).toContain('renamed later')
  })

  it('ignores other events, recording them', async () => {
    const res = await handleGithubWebhook(
      delivery('issues', '{"action":"opened"}', { id: DELIVERY }),
      deps,
    )
    expect(await res.json()).toEqual({ status: 'ignored', reason: 'event' })
    expect(h.deliveries.get(DELIVERY)?.outcome).toBe('ignored:event')
    expect(h.refreshes).toBe(0)
  })
})

describe('handleGithubWebhook: push', () => {
  beforeEach(() => writeSecret(SECRET))

  it('queues a build for an app with box builds on, and the delivery row names it', async () => {
    const res = await handleGithubWebhook(
      delivery('push', pushBody({ sender: 'octo-sender' }), { id: DELIVERY }),
      deps,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'queued', build: 'build-1', superseded: 0 })
    expect(h.builds).toEqual([
      expect.objectContaining({
        id: 'build-1',
        appId: 'app-iris',
        lane: 'main',
        sha: SHA,
        strategy: 'dockerfile',
        publish: 'live',
        requestedBy: 'webhook',
        actor: 'octo-sender',
        deliveryId: DELIVERY,
        state: 'queued',
      }),
    ])
    expect(h.deliveries.get(DELIVERY)).toEqual({
      id: DELIVERY,
      event: 'push',
      action: null,
      outcome: 'queued:build-1',
    })
    expect(logged()).not.toContain('marker-do-not-log-me')
    expect(logged()).not.toContain('octo-sender')
  })

  it('supersedes the lane’s queued build', async () => {
    h.builds = [existingBuild({})]
    const res = await handleGithubWebhook(delivery('push', pushBody()), deps)
    expect(await res.json()).toEqual({ status: 'queued', build: 'build-1', superseded: 1 })
    expect(h.builds.map((b) => [b.id, b.state])).toEqual([
      ['build-old', 'superseded'],
      ['build-1', 'queued'],
    ])
  })

  it('reports a sha already waiting in the lane as queued, not a new build', async () => {
    h.builds = [existingBuild({ sha: SHA })]
    const res = await handleGithubWebhook(delivery('push', pushBody(), { id: DELIVERY }), deps)
    expect(await res.json()).toEqual({
      status: 'queued',
      build: 'build-old',
      superseded: 0,
      alreadyQueued: true,
    })
    expect(h.deliveries.get(DELIVERY)?.outcome).toBe('already-queued:build-old')
  })

  it('writes the delivery and the build in one transaction', async () => {
    await handleGithubWebhook(delivery('push', pushBody(), { id: DELIVERY }), deps)
    expect(h.txs).toHaveLength(1)
    expect(h.enqueueExecs).toEqual([h.txs[0]])
  })

  it('rolls the delivery back with a failed enqueue, so its redelivery still builds', async () => {
    h.enqueueError = Object.assign(new Error('insert into builds … iris … failed'), {
      code: '08006',
    })
    const failed = await handleGithubWebhook(delivery('push', pushBody(), { id: DELIVERY }), deps)
    expect(failed.status).toBe(500)
    expect(h.deliveries.size).toBe(0)
    expect(h.builds).toHaveLength(0)
    const errors = logged()
    expect(errors).toContain(`${DELIVERY} event push outcome error 08006`)
    expect(errors).not.toContain('iris')

    h.enqueueError = null
    const redelivered = await handleGithubWebhook(
      delivery('push', pushBody(), { id: DELIVERY }),
      deps,
    )
    expect(await redelivered.json()).toEqual({ status: 'queued', build: 'build-1', superseded: 0 })
    expect(h.deliveries.get(DELIVERY)?.outcome).toBe('queued:build-1')
  })

  it('ignores a push to an app with box builds off', async () => {
    h.apps = [iris({ buildOnBox: false })]
    const res = await handleGithubWebhook(delivery('push', pushBody(), { id: DELIVERY }), deps)
    expect(await res.json()).toEqual({ status: 'ignored', reason: 'box-builds-off' })
    expect(h.builds).toHaveLength(0)
    expect(h.deliveries.get(DELIVERY)?.outcome).toBe('ignored:box-builds-off')
  })

  it.each([
    ['an unpinned repo', {}, { githubRepoId: null }, 'repo-not-pinned'],
    ['a recreated repo (id mismatch)', { repoId: REPO_ID + 1 }, {}, 'repo-mismatch'],
    ['a fork', { fork: true }, {}, 'fork'],
    ['a non-default branch', { ref: 'refs/heads/feature' }, {}, 'non-default-branch'],
    ['a tag', { ref: 'refs/tags/v1.0.0' }, {}, 'tag'],
    ['a repo no app is named after', { name: 'santree', repoId: REPO_ID + 2 }, {}, 'no-app'],
    ['an app declared in nix', {}, { managedInNix: true }, 'managed-in-nix'],
    ['a local-source app', {}, { sourceMode: 'local' }, 'not-registry-mode'],
  ] as const)('ignores a push from %s', async (_label, push, app, reason) => {
    h.apps = [iris(app)]
    const res = await handleGithubWebhook(delivery('push', pushBody(push)), deps)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ignored', reason })
    expect(h.builds).toHaveLength(0)
    expect(h.enqueueExecs).toHaveLength(0)
  })

  it('builds a renamed repo for its pinned app, and not a new repo under the old name', async () => {
    h.apps = [iris()]
    const renamed = await handleGithubWebhook(
      delivery('push', pushBody({ name: 'iris-web' })),
      deps,
    )
    expect(await renamed.json()).toEqual({ status: 'queued', build: 'build-1', superseded: 0 })
    expect(h.builds).toEqual([expect.objectContaining({ appId: 'app-iris', sha: SHA })])

    const tookOldName = await handleGithubWebhook(
      delivery('push', pushBody({ name: 'Iris', repoId: REPO_ID + 7, after: OLDER_SHA })),
      deps,
    )
    expect(await tookOldName.json()).toEqual({ status: 'ignored', reason: 'repo-mismatch' })

    const unrelated = await handleGithubWebhook(
      delivery('push', pushBody({ name: 'iris-legacy', repoId: REPO_ID + 7 })),
      deps,
    )
    expect(await unrelated.json()).toEqual({ status: 'ignored', reason: 'no-app' })
    expect(h.builds).toHaveLength(1)
  })

  it('ignores a push from another installation', async () => {
    h.installationId = INSTALLATION_ID + 1
    const res = await handleGithubWebhook(delivery('push', pushBody()), deps)
    expect(await res.json()).toEqual({ status: 'ignored', reason: 'installation-mismatch' })
  })

  it('ignores a push while no App identity is committed', async () => {
    h.identity = null
    const res = await handleGithubWebhook(delivery('push', pushBody(), { id: DELIVERY }), deps)
    expect(await res.json()).toEqual({ status: 'ignored', reason: 'no-app-identity' })
    expect(h.deliveries.get(DELIVERY)?.outcome).toBe('ignored:no-app-identity')
  })

  it.each([
    ['building', { state: 'building', sha: SHA }, 'already-running'],
    ['built for this publish mode', { state: 'succeeded', sha: SHA }, 'already-built'],
  ] as const)('ignores a replayed tip the lane has %s', async (_label, build, reason) => {
    h.builds = [existingBuild(build)]
    const res = await handleGithubWebhook(delivery('push', pushBody()), deps)
    expect(await res.json()).toEqual({ status: 'ignored', reason })
    expect(h.enqueueExecs).toHaveLength(0)
  })

  it('builds a sha whose only success was a candidate when the app now publishes live', async () => {
    h.builds = [existingBuild({ state: 'succeeded', sha: SHA, publish: 'candidate' })]
    const res = await handleGithubWebhook(delivery('push', pushBody()), deps)
    expect((await res.json()).status).toBe('queued')
  })

  it('answers 400 to a push payload that does not decode, recording nothing', async () => {
    const res = await handleGithubWebhook(
      delivery('push', '{"ref":"refs/heads/main","marker":"marker-do-not-log-me"}'),
      deps,
    )
    expect(res.status).toBe(400)
    expect(h.txs).toHaveLength(0)
    expect(logged()).not.toContain('marker-do-not-log-me')
  })
})
