import { createHash, generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GITHUB_APP_EVENTS, GITHUB_APP_PERMISSIONS } from '../../lib/github-app'
import type { Ctx } from '../ctx'
import type { SiteDocument, SiteGithubApp } from '../site/file'

// The manifest flow's server half. Everything that leaves the process is
// mocked: GitHub (fetch), sops (sealJsonForVault), the Apply bridge and the
// committed site.json. The store is an in-memory map behind a real Ctx shape.

const h = vi.hoisted(() => ({
  blocker: null as string | null,
  apply: { ok: true, id: 'apply-1', changed: [] } as unknown,
  applyCalls: [] as unknown[][],
  /** A value, or a function returning one (to hold the seal open). */
  seal: { ok: true, ciphertext: 'ENC[sealed-github-app]' } as unknown,
  sealCalls: [] as unknown[][],
  site: { present: false, error: null } as unknown,
  installation: null as unknown,
}))

vi.mock('../../lib/apply-flow', () => ({
  secretApplyBlocker: async () => h.blocker,
  runSecretApply: async (...args: unknown[]) => {
    h.applyCalls.push(args)
    return h.apply
  },
}))
vi.mock('../vault', () => ({
  sealJsonForVault: async (...args: unknown[]) => {
    h.sealCalls.push(args)
    return typeof h.seal === 'function' ? await (h.seal as () => Promise<unknown>)() : h.seal
  },
}))
vi.mock('../../lib/contract/domains/site-doc', () => ({ readCommittedSite: async () => h.site }))
vi.mock('../../lib/repo/settings', () => ({
  SETTING_KEYS: {
    githubAppCreation: 'github.app.creation',
    githubAppPendingApply: 'github.app.pendingApply',
  },
}))
vi.mock('../../lib/site', () => ({ OWNER: 'octo', BASE_DOMAIN: 'fallback.test' }))
vi.mock('../github-app', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../github-app')>()),
  installationState: async () => h.installation,
}))

const {
  DISABLED_REASON,
  FINISH_LOCK_MS,
  NO_ACTOR_REASON,
  actorFrom,
  callbackLocation,
  discardPendingApply,
  finishAppCreation,
  githubAppStatus,
  githubCallback,
  grantError,
  pasteAppKey,
  pemError,
  retryPendingApply,
  shortReason,
  startAppCreation,
} = await import('./github-app')

const CREATION = 'github.app.creation'
const PENDING = 'github.app.pendingApply'
const ACTOR = 'op@example.test'
const OWNER_ID = 4242
const CODE = 'a180b1a3d263c81bc6441d7b990bae27d4c10679'
const WEBHOOK = 'whsec-Zq81Lm0pQ4rT7uVw'
const CLIENT_SECRET = 'c0ffee0123456789abcdef0123456789abcdef01'
const TOKEN = `ghs${'_'}${'Q9w8E7r6'.repeat(5)}`

const { privateKey: PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
})
/** One base64 body line: enough of the key to count as a leak. */
const PEM_LINE = PEM.split('\n')[1] ?? ''
const SECRETS = [CODE, WEBHOOK, CLIENT_SECRET, PEM_LINE]

const APP: SiteGithubApp = {
  id: 987_654,
  slug: 'daedalus-example',
  clientId: 'Iv23liEXAMPLE',
  htmlUrl: 'https://github.com/apps/daedalus-example',
  owner: 'octo',
  ownerId: OWNER_ID,
}

const DOC: SiteDocument = {
  schemaVersion: 1,
  identity: {
    hostname: 'box',
    baseDomain: 'example.test',
    controlPlane: 'ctl',
    controlPlanePrevious: null,
    timezone: 'UTC',
    owner: 'octo',
    operator: { user: 'u', group: 'g' },
  },
  network: {
    lanIp: '10.0.0.2',
    interface: 'eth0',
    gateway: '10.0.0.1',
    wanHost: 'box.example.test',
    ddns: { host: 'box.example.test', interval: '300s' },
    dhcp: {
      active: true,
      router: '10.0.0.1',
      start: '10.0.0.100',
      end: '10.0.0.200',
      leaseTime: '8h',
    },
    dnsUpstreams: ['1.1.1.1'],
  },
  mail: { sender: 's@example.test', alertTo: 'a@example.test' },
  cloudflare: { accountId: 'acc', zoneId: 'zone', tunnelId: 'tun' },
}

const committed = (app: SiteGithubApp | null) => ({
  present: true,
  doc: app === null ? DOC : { ...DOC, github: { app } },
  bytes: '',
})

const pendingRecord = (over: Record<string, unknown> = {}) => ({
  ciphertext: 'ENC[x]',
  github: APP,
  at: '2026-09-11T20:00:00Z',
  reason: 'r',
  replace: false,
  priorAppId: null,
  ...over,
})

const REFUSED = {
  ok: false,
  code: 'pending',
  reason: 'Apply or undo the pending changes first (site).',
}

function fakeCtx(
  env: Record<string, string> = { GITHUB_APP_ENABLED: '1' },
  shared?: Map<string, unknown>,
) {
  const store = shared ?? new Map<string, unknown>()
  const ctx = {
    env: (name: string) => env[name],
    secret: () => '',
    exportPath: (f: string) => f,
    snapshot: async () => {
      throw new Error('not used')
    },
    store: {
      read: async (key: string, guard: (v: unknown) => boolean) => {
        const v = store.get(key)
        return guard(v) ? structuredClone(v) : undefined
      },
      write: async (key: string, value: unknown) => {
        store.set(key, structuredClone(value))
      },
      delete: async (key: string) => {
        store.delete(key)
      },
    },
    http: { getJson: async () => null },
    loki: { latest: async () => null, entries: async () => [] },
  } as unknown as Ctx
  return { ctx, store }
}

type GithubStub = { type?: string; conversion?: Record<string, unknown>; conversionStatus?: number }

const conversionReply = () => ({
  id: APP.id,
  slug: APP.slug,
  node_id: 'A_kwDO',
  owner: { login: 'octo', id: OWNER_ID, type: 'User' },
  name: 'daedalus-example',
  client_id: APP.clientId,
  client_secret: CLIENT_SECRET,
  webhook_secret: WEBHOOK,
  pem: PEM,
  html_url: APP.htmlUrl,
  permissions: { ...GITHUB_APP_PERMISSIONS },
  events: [...GITHUB_APP_EVENTS],
})

let calls: string[] = []

function stubGithub(stub: GithubStub = {}) {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input)
      calls.push(url)
      if (url === 'https://api.github.com/users/octo') {
        return Response.json({ id: OWNER_ID, login: 'octo', type: stub.type ?? 'User' })
      }
      if (url.startsWith('https://api.github.com/app-manifests/')) {
        return Response.json(
          { ...conversionReply(), ...stub.conversion },
          { status: stub.conversionStatus ?? 201 },
        )
      }
      return new Response(null, { status: 404 })
    }),
  )
}

const conversions = () => calls.filter((u) => u.includes('/app-manifests/')).length

async function begin(ctx: Ctx, replace = false): Promise<string> {
  const r = await startAppCreation(ctx, ACTOR, { name: 'daedalus-example', replace })
  if (!r.ok) throw new Error(r.reason)
  return r.state
}

const leaks = (text: string) => SECRETS.filter((s) => text.includes(s))

const request = (query: string, email: string | null = ACTOR) =>
  new Request(`http://app-daedalus:3000/settings/github/callback?${query}`, {
    headers: email === null ? {} : { 'x-forwarded-email': email },
  })

const location = (r: Response) => r.headers.get('location') ?? ''

beforeEach(() => {
  h.blocker = null
  h.apply = { ok: true, id: 'apply-1', changed: [] }
  h.applyCalls = []
  h.seal = { ok: true, ciphertext: 'ENC[sealed-github-app]' }
  h.sealCalls = []
  h.site = committed(null)
  h.installation = {
    data: null,
    available: false,
    generatedAt: null,
    ageMs: null,
    stale: false,
    error: null,
  }
  stubGithub()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete (globalThis as { daedalusGithubAppFinishHold?: unknown }).daedalusGithubAppFinishHold
})

describe('the disabled flag', () => {
  it('refuses every mutation until the host can take the vault file', async () => {
    const { ctx, store } = fakeCtx({})
    h.site = committed(APP)
    const refused = { ok: false, reason: DISABLED_REASON }
    expect(await startAppCreation(ctx, ACTOR, { name: 'daedalus-example' })).toEqual(refused)
    expect(
      await pasteAppKey(ctx, ACTOR, {
        pem: PEM,
        webhookSecret: WEBHOOK,
        clientSecret: CLIENT_SECRET,
      }),
    ).toEqual(refused)
    store.set(PENDING, pendingRecord())
    expect(await retryPendingApply(ctx, ACTOR)).toEqual(refused)
    expect(await discardPendingApply(ctx, ACTOR)).toEqual(refused)
    expect(store.has(PENDING)).toBe(true)
    expect(calls).toEqual([])
    expect(h.sealCalls).toEqual([])
    expect(h.applyCalls).toEqual([])
  })

  it('refuses the callback without converting or consuming the record', async () => {
    const shared = new Map<string, unknown>()
    const on = fakeCtx(undefined, shared)
    const state = await begin(on.ctx)
    const off = fakeCtx({}, shared)
    stubGithub()
    expect(await finishAppCreation(off.ctx, ACTOR, CODE, state)).toEqual({
      outcome: 'failed',
      code: 'disabled',
      reason: DISABLED_REASON,
    })
    expect(conversions()).toBe(0)
    expect(shared.has(CREATION)).toBe(true)
  })

  it('only "1" enables', async () => {
    const { ctx } = fakeCtx({ GITHUB_APP_ENABLED: 'true' })
    expect(await startAppCreation(ctx, ACTOR, { name: 'x' })).toMatchObject({ ok: false })
  })
})

describe('the signed-in identity', () => {
  it('reads a missing or blank header as no one', () => {
    expect(actorFrom(undefined)).toBeNull()
    expect(actorFrom(null)).toBeNull()
    expect(actorFrom('')).toBeNull()
    expect(actorFrom('   ')).toBeNull()
    expect(actorFrom(' op@example.test ')).toBe('op@example.test')
  })

  it('refuses every mutation without one', async () => {
    const { ctx, store } = fakeCtx()
    h.site = committed(APP)
    const refused = { ok: false, reason: NO_ACTOR_REASON }
    expect(await startAppCreation(ctx, null, { name: 'daedalus-example' })).toEqual(refused)
    expect(
      await pasteAppKey(ctx, null, {
        pem: PEM,
        webhookSecret: WEBHOOK,
        clientSecret: CLIENT_SECRET,
      }),
    ).toEqual(refused)
    store.set(PENDING, pendingRecord())
    expect(await retryPendingApply(ctx, null)).toEqual(refused)
    expect(await discardPendingApply(ctx, null)).toEqual(refused)
    expect(store.has(PENDING)).toBe(true)
    expect(store.has(CREATION)).toBe(false)
    expect(calls).toEqual([])
    expect(h.sealCalls).toEqual([])
    expect(h.applyCalls).toEqual([])
  })

  it('refuses a callback without one, leaving the creation for the real callback', async () => {
    const { ctx, store } = fakeCtx()
    const state = await begin(ctx)
    stubGithub()
    for (const email of [null, '', '   ']) {
      const r = await githubCallback(ctx, request(`code=${CODE}&state=${state}`, email))
      expect(location(r)).toBe('/settings?tab=integrations&github=failed&reason=other-actor')
    }
    expect(await finishAppCreation(ctx, null, CODE, state)).toMatchObject({ code: 'other-actor' })
    expect(store.has(CREATION)).toBe(true)
    expect(conversions()).toBe(0)

    const real = await githubCallback(ctx, request(`code=${CODE}&state=${state}`))
    expect(location(real)).toBe('/settings?tab=integrations&github=created')
  })
})

describe('startAppCreation', () => {
  it('stores only the state hash, bound to the actor and the owner id, for an hour', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-09-11T20:00:00Z'))
    const { ctx, store } = fakeCtx()
    const r = await startAppCreation(ctx, ACTOR, { name: '  daedalus-example ' })
    if (!r.ok) throw new Error(r.reason)

    expect(r.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(r.action).toBe(`https://github.com/settings/apps/new?state=${r.state}`)
    const manifest = JSON.parse(r.manifest)
    expect(manifest.name).toBe('daedalus-example')
    expect(manifest.redirect_url).toBe('https://ctl.example.test/settings/github/callback')
    expect(manifest.hook_attributes.url).toBe('https://hooks.example.test/api/github/webhook')

    const record = store.get(CREATION)
    expect(record).toEqual({
      stateHash: createHash('sha256').update(r.state).digest('hex'),
      actor: ACTOR,
      ownerId: OWNER_ID,
      expiresAt: Date.parse('2026-09-11T21:00:00Z'),
      replace: false,
    })
    expect(JSON.stringify(record)).not.toContain(r.state)
  })

  it('posts to the organization form when the owner is an organization', async () => {
    stubGithub({ type: 'Organization' })
    const r = await startAppCreation(fakeCtx().ctx, ACTOR, { name: 'daedalus-example' })
    if (!r.ok) throw new Error(r.reason)
    expect(
      r.action.startsWith('https://github.com/organizations/octo/settings/apps/new?state='),
    ).toBe(true)
  })

  it('refuses while anything else waits to be applied', async () => {
    h.blocker =
      'Apply or undo the pending changes first (site): replacing a secret is its own Apply.'
    const { ctx, store } = fakeCtx()
    expect(await startAppCreation(ctx, ACTOR, { name: 'daedalus-example' })).toEqual({
      ok: false,
      reason: h.blocker,
    })
    expect(store.size).toBe(0)
    expect(calls).toEqual([])
  })

  it('refuses while a created App waits for its own Apply', async () => {
    const { ctx } = fakeCtx()
    await ctx.store.write(PENDING, pendingRecord())
    expect(await startAppCreation(ctx, ACTOR, { name: 'daedalus-example' })).toMatchObject({
      ok: false,
    })
  })

  it('refuses a second App unless replacing', async () => {
    h.site = committed(APP)
    const { ctx } = fakeCtx()
    expect(await startAppCreation(ctx, ACTOR, { name: 'daedalus-example' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('already has a GitHub App'),
    })
    expect(
      await startAppCreation(ctx, ACTOR, { name: 'daedalus-example', replace: true }),
    ).toMatchObject({ ok: true })
  })

  it('holds names to GitHub’s 34-character limit', async () => {
    const { ctx } = fakeCtx()
    expect(await startAppCreation(ctx, ACTOR, { name: 'a'.repeat(34) })).toMatchObject({ ok: true })
    expect(await startAppCreation(ctx, ACTOR, { name: 'a'.repeat(35) })).toMatchObject({
      ok: false,
    })
    expect(await startAppCreation(ctx, ACTOR, { name: '' })).toMatchObject({ ok: false })
    expect(await startAppCreation(ctx, ACTOR, { name: '-leading' })).toMatchObject({ ok: false })
  })

  it('refuses without a committed site.json to record the App in', async () => {
    h.site = { present: false, error: null }
    expect(
      await startAppCreation(fakeCtx().ctx, ACTOR, { name: 'daedalus-example' }),
    ).toMatchObject({ ok: false })
  })
})

describe('finishAppCreation', () => {
  it('converts once, seals the three values and applies them beside site.json', async () => {
    const { ctx, store } = fakeCtx()
    const state = await begin(ctx)
    stubGithub()

    expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toEqual({
      outcome: 'created',
      id: 'apply-1',
    })
    expect(conversions()).toBe(1)
    expect(calls[0]).toBe(`https://api.github.com/app-manifests/${CODE}/conversions`)
    expect(store.has(CREATION)).toBe(false)

    expect(h.sealCalls).toEqual([
      ['vault/github-app.sops', { pem: PEM, webhookSecret: WEBHOOK, clientSecret: CLIENT_SECRET }],
    ])
    const [actor, secret, opts] = h.applyCalls[0] as [
      string,
      unknown,
      { extraFiles: { 'site.json': string } },
    ]
    expect(actor).toBe(ACTOR)
    expect(secret).toEqual({
      file: 'vault/github-app.sops',
      name: 'github-app',
      ciphertext: 'ENC[sealed-github-app]',
    })
    const site = opts.extraFiles['site.json']
    expect(JSON.parse(site).github).toEqual({ app: APP })
    expect(JSON.parse(site).identity.baseDomain).toBe('example.test')
    expect(leaks(site)).toEqual([])
  })

  it('leaves the creation intact after a forged callback, so the real one still succeeds', async () => {
    const { ctx, store } = fakeCtx()
    const state = await begin(ctx)
    stubGithub()
    const forged = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`

    const mismatch = '/settings?tab=integrations&github=failed&reason=state-mismatch'
    expect(location(await githubCallback(ctx, request(`code=${CODE}&state=${forged}`)))).toBe(
      mismatch,
    )
    expect(location(await githubCallback(ctx, request('state=x')))).toBe(mismatch)
    expect(location(await githubCallback(ctx, request('')))).toBe(mismatch)
    expect(store.has(CREATION)).toBe(true)
    expect(conversions()).toBe(0)

    expect(location(await githubCallback(ctx, request(`code=${CODE}&state=${state}`)))).toBe(
      '/settings?tab=integrations&github=created',
    )
    expect(conversions()).toBe(1)
  })

  it('refuses a reused state: the record is gone after the first match', async () => {
    const { ctx } = fakeCtx()
    const state = await begin(ctx)
    stubGithub()
    expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toMatchObject({ outcome: 'created' })
    expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toMatchObject({
      outcome: 'failed',
      code: 'state-mismatch',
    })
    expect(conversions()).toBe(1)
  })

  it('refuses two callbacks racing for the same state', async () => {
    const { ctx } = fakeCtx()
    const state = await begin(ctx)
    stubGithub()
    const outcomes = await Promise.all([
      finishAppCreation(ctx, ACTOR, CODE, state),
      finishAppCreation(ctx, ACTOR, CODE, state),
    ])
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['created', 'failed'])
    expect(conversions()).toBe(1)
  })

  it('refuses an expired state without converting', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-09-11T20:00:00Z'))
    const { ctx } = fakeCtx()
    const state = await begin(ctx)
    stubGithub()
    vi.setSystemTime(Date.parse('2026-09-11T21:00:00Z'))
    expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toMatchObject({
      outcome: 'failed',
      code: 'state-expired',
    })
    expect(conversions()).toBe(0)
  })

  it('refuses a state someone else started, and keeps it for its owner', async () => {
    const { ctx, store } = fakeCtx()
    const state = await begin(ctx)
    stubGithub()
    expect(await finishAppCreation(ctx, 'mallory@example.test', CODE, state)).toMatchObject({
      outcome: 'failed',
      code: 'other-actor',
    })
    expect(conversions()).toBe(0)
    expect(store.has(CREATION)).toBe(true)
    expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toMatchObject({ outcome: 'created' })
  })

  it('refuses an App GitHub created under another account', async () => {
    const { ctx } = fakeCtx()
    const state = await begin(ctx)
    stubGithub({ conversion: { owner: { login: 'someone-else', id: 7, type: 'User' } } })
    const r = await finishAppCreation(ctx, ACTOR, CODE, state)
    expect(r).toMatchObject({
      outcome: 'failed',
      code: 'owner-mismatch',
      reason: expect.stringContaining('someone-else'),
    })
    expect(h.sealCalls).toEqual([])
    expect(h.applyCalls).toEqual([])
  })

  it('refuses an App registered with other permissions or events than the manifest', async () => {
    expect(grantError(conversionReply())).toBeNull()
    expect(grantError({})).not.toBeNull()

    for (const conversion of [
      { permissions: { ...GITHUB_APP_PERMISSIONS, administration: 'write' } },
      { permissions: { ...GITHUB_APP_PERMISSIONS, contents: 'write' } },
      { events: ['push'] },
      { events: undefined },
    ]) {
      const { ctx } = fakeCtx()
      const state = await begin(ctx)
      stubGithub({ conversion })
      expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toMatchObject({
        outcome: 'failed',
        code: 'conversion-failed',
      })
    }
    expect(h.sealCalls).toEqual([])
    expect(h.applyCalls).toEqual([])
  })

  it('reports a refused conversion without the code', async () => {
    const { ctx } = fakeCtx()
    const state = await begin(ctx)
    stubGithub({ conversionStatus: 404 })
    const r = await finishAppCreation(ctx, ACTOR, CODE, state)
    expect(r).toMatchObject({ outcome: 'failed', code: 'conversion-failed' })
    expect(leaks(JSON.stringify(r))).toEqual([])
  })

  it('tells a conversion that timed out from one that failed', async () => {
    const { ctx } = fakeCtx()
    const state = await begin(ctx)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }),
    )
    expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toMatchObject({
      outcome: 'failed',
      code: 'conversion-timeout',
    })
    expect(h.sealCalls).toEqual([])
  })

  it('refuses to overwrite an App committed since the creation started, unless replacing', async () => {
    const { ctx } = fakeCtx()
    const state = await begin(ctx)
    h.site = committed(APP)
    stubGithub()
    expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toMatchObject({
      outcome: 'failed',
      code: 'already-created',
    })
    expect(conversions()).toBe(0)

    const replacing = await begin(ctx, true)
    stubGithub()
    expect(await finishAppCreation(ctx, ACTOR, CODE, replacing)).toMatchObject({
      outcome: 'created',
    })
  })

  it('keeps only ciphertext when the Apply is refused, and Retry Apply clears it', async () => {
    const { ctx, store } = fakeCtx()
    const state = await begin(ctx)
    stubGithub()
    h.apply = REFUSED

    const r = await finishAppCreation(ctx, ACTOR, CODE, state)
    expect(r).toEqual({ outcome: 'pending', code: 'apply-refused', reason: REFUSED.reason })
    const pending = store.get(PENDING) as Record<string, unknown>
    expect(Object.keys(pending).sort()).toEqual([
      'at',
      'ciphertext',
      'github',
      'priorAppId',
      'reason',
      'replace',
    ])
    expect(pending).toMatchObject({
      ciphertext: 'ENC[sealed-github-app]',
      github: APP,
      replace: false,
      priorAppId: null,
    })
    expect(leaks(JSON.stringify(pending))).toEqual([])

    h.apply = { ok: false, code: 'busy', reason: 'an apply is already running (building)' }
    expect(await retryPendingApply(ctx, ACTOR)).toEqual({
      ok: false,
      reason: 'an apply is already running (building)',
    })
    expect((store.get(PENDING) as { reason: string }).reason).toBe(
      'an apply is already running (building)',
    )

    h.apply = { ok: true, id: 'apply-2', changed: [] }
    expect(await retryPendingApply(ctx, ACTOR)).toEqual({ ok: true, id: 'apply-2' })
    expect(store.has(PENDING)).toBe(false)
    const last = h.applyCalls.at(-1) as [
      string,
      { ciphertext: string },
      { extraFiles: { 'site.json': string } },
    ]
    expect(last[1].ciphertext).toBe('ENC[sealed-github-app]')
    expect(JSON.parse(last[2].extraFiles['site.json']).github).toEqual({ app: APP })
  })

  it('refuses a retry once site.json names an App the pending one was not created to follow', async () => {
    const { ctx, store } = fakeCtx()
    const state = await begin(ctx)
    stubGithub()
    h.apply = REFUSED
    expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toMatchObject({ outcome: 'pending' })

    h.site = committed({ ...APP, id: 111, slug: 'another-app' })
    h.apply = { ok: true, id: 'apply-2', changed: [] }
    expect(await retryPendingApply(ctx, ACTOR)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('111'),
    })
    expect(h.applyCalls).toHaveLength(1)
    expect(store.has(PENDING)).toBe(true)
  })

  it('retries a replacement only while the App it replaces is still the committed one', async () => {
    h.site = committed(APP)
    const { ctx, store } = fakeCtx()
    const state = await begin(ctx, true)
    stubGithub({ conversion: { id: 222, slug: 'daedalus-new' } })
    h.apply = REFUSED
    expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toMatchObject({ outcome: 'pending' })
    expect(store.get(PENDING)).toMatchObject({ replace: true, priorAppId: APP.id })

    h.apply = { ok: true, id: 'apply-2', changed: [] }
    h.site = committed(null)
    expect(await retryPendingApply(ctx, ACTOR)).toMatchObject({
      ok: false,
      reason: expect.stringContaining(String(APP.id)),
    })

    h.site = committed(APP)
    expect(await retryPendingApply(ctx, ACTOR)).toEqual({ ok: true, id: 'apply-2' })
    const last = h.applyCalls.at(-1) as [string, unknown, { extraFiles: { 'site.json': string } }]
    expect(JSON.parse(last[2].extraFiles['site.json']).github.app.id).toBe(222)
  })

  it('lets a later callback take over a lock held past its limit, and ignores the old holder', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const { ctx } = fakeCtx()
    const first = await begin(ctx)
    stubGithub()

    let reached: () => void = () => undefined
    const atSeal = new Promise<void>((resolve) => {
      reached = resolve
    })
    let unblock: (value: unknown) => void = () => undefined
    h.seal = () => {
      reached()
      return new Promise((resolve) => {
        unblock = resolve
      })
    }
    const hung = finishAppCreation(ctx, ACTOR, CODE, first)
    await atSeal

    h.seal = { ok: true, ciphertext: 'ENC[second]' }
    const second = await begin(ctx)
    const waiting = finishAppCreation(ctx, ACTOR, CODE, second)

    await vi.advanceTimersByTimeAsync(FINISH_LOCK_MS - 1_000)
    expect(h.applyCalls).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(waiting).resolves.toEqual({ outcome: 'created', id: 'apply-1' })

    unblock({ ok: true, ciphertext: 'ENC[first]' })
    await expect(hung).resolves.toMatchObject({ outcome: 'failed', code: 'unknown' })
    expect(h.applyCalls).toHaveLength(1)
    const [, applied] = h.applyCalls[0] as [string, { ciphertext: string }]
    expect(applied.ciphertext).toBe('ENC[second]')
  })

  it('takes over a lock slot it does not recognise instead of waiting on it', async () => {
    // What a Vite re-evaluation leaves behind: globalThis outlives the module,
    // so the slot can hold whatever an older version of this file put there.
    for (const stale of [Promise.resolve(), {}, { takenAt: 'soon' }, null]) {
      Object.assign(globalThis, { daedalusGithubAppFinishHold: stale })
      const { ctx } = fakeCtx()
      const state = await begin(ctx)
      stubGithub()
      expect(await finishAppCreation(ctx, ACTOR, CODE, state)).toMatchObject({
        outcome: 'created',
      })
    }
  })

  it('never puts a secret in any reason it returns', async () => {
    const outcomes: unknown[] = []
    for (const stub of [
      { conversionStatus: 500 },
      { conversion: { pem: 'not a key' } },
      { conversion: { owner: { login: 'x', id: 1 } } },
      {},
    ] satisfies GithubStub[]) {
      const { ctx } = fakeCtx()
      const state = await begin(ctx)
      stubGithub(stub)
      h.seal = { ok: false, reason: 'sops failed: [secret]' }
      outcomes.push(await finishAppCreation(ctx, ACTOR, CODE, state))
    }
    expect(outcomes.every((o) => (o as { outcome: string }).outcome === 'failed')).toBe(true)
    expect(leaks(JSON.stringify(outcomes))).toEqual([])
  })
})

describe('discardPendingApply', () => {
  it('forgets the pending Apply and says which App it was', async () => {
    const { ctx, store } = fakeCtx()
    store.set(PENDING, pendingRecord())
    expect(await discardPendingApply(ctx, ACTOR)).toEqual({
      ok: true,
      slug: APP.slug,
      htmlUrl: APP.htmlUrl,
    })
    expect(store.has(PENDING)).toBe(false)
    expect(
      (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join('\n'),
    ).toContain(`${ACTOR} discarded the pending Apply for ${APP.slug}`)
    expect((await githubAppStatus(ctx)).state).toBe('none')

    expect(await discardPendingApply(ctx, ACTOR)).toMatchObject({ ok: false })
    expect(h.applyCalls).toEqual([])
  })
})

describe('pasteAppKey', () => {
  const input = { pem: PEM, webhookSecret: WEBHOOK, clientSecret: CLIENT_SECRET }

  it('needs an App in site.json', async () => {
    expect(await pasteAppKey(fakeCtx().ctx, ACTOR, input)).toMatchObject({ ok: false })
    expect(h.sealCalls).toEqual([])
  })

  it('seals a normalised key with both new secrets and applies it without site.json', async () => {
    h.site = committed(APP)
    const pasted = `  ${PEM.trim().split('\n').join('\r\n  ')}\r\n\r\n`
    expect(await pasteAppKey(fakeCtx().ctx, ACTOR, { ...input, pem: pasted })).toEqual({
      ok: true,
      id: 'apply-1',
    })
    expect(h.sealCalls).toEqual([['vault/github-app.sops', input]])
    expect(h.applyCalls[0]).toHaveLength(2)
  })

  it('rejects anything that is not the whole RSA key, without repeating it', async () => {
    h.site = committed(APP)
    const { privateKey: pkcs8 } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const { privateKey: ec } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
    })
    const ecUnderRsaHeader = ec
      .replace('BEGIN EC PRIVATE KEY', 'BEGIN RSA PRIVATE KEY')
      .replace('END EC PRIVATE KEY', 'END RSA PRIVATE KEY')
    const lines = PEM.trim().split('\n')
    const cases = [
      '',
      pkcs8,
      ecUnderRsaHeader,
      lines.slice(0, -1).join('\n'),
      [lines[0], 'not base64 at all!', lines.at(-1)].join('\n'),
      [lines[0], lines.at(-1)].join('\n'),
    ]
    for (const pem of cases) {
      expect(pemError(pem), pem.slice(0, 40)).not.toBeNull()
      const r = await pasteAppKey(fakeCtx().ctx, ACTOR, { ...input, pem })
      expect(r.ok).toBe(false)
      expect(leaks(JSON.stringify(r))).toEqual([])
    }
    expect(pemError(PEM)).toBeNull()
    expect(h.sealCalls).toEqual([])
  })

  it('rejects a missing or padded secret', async () => {
    h.site = committed(APP)
    for (const bad of [
      { webhookSecret: '' },
      { webhookSecret: ` ${WEBHOOK}` },
      { clientSecret: '' },
      { clientSecret: `${CLIENT_SECRET}\n` },
    ]) {
      const r = await pasteAppKey(fakeCtx().ctx, ACTOR, { ...input, ...bad })
      expect(r.ok).toBe(false)
      expect(leaks(JSON.stringify(r))).toEqual([])
    }
    expect(h.sealCalls).toEqual([])
  })
})

describe('githubAppStatus', () => {
  const snapshot = (data: Record<string, unknown>, stale = false) => ({
    data: {
      version: 1,
      state: 'ok',
      reason: null,
      installationId: 81,
      account: { login: 'octo', id: OWNER_ID },
      repositorySelection: 'selected',
      token: TOKEN,
      expiresAt: '2026-09-11T21:00:00Z',
      mintedAt: '2026-09-11T20:00:00Z',
      ...data,
    },
    available: true,
    generatedAt: null,
    ageMs: null,
    stale,
    error: null,
  })

  it('reads none, created, installed, installed elsewhere and pending', async () => {
    const { ctx, store } = fakeCtx({})
    const none = await githubAppStatus(ctx)
    expect(none).toMatchObject({
      enabled: false,
      state: 'none',
      defaultName: 'daedalus-example',
      nameMax: 34,
      appsUrl: 'https://github.com/settings/apps',
    })
    expect(none.identity).toBeUndefined()

    h.site = committed(APP)
    h.installation = snapshot({ state: 'not-installed', account: null, token: null })
    expect(await githubAppStatus(ctx)).toMatchObject({
      state: 'created',
      identity: APP,
      installUrl: 'https://github.com/apps/daedalus-example/installations/new',
    })

    h.installation = snapshot({})
    const installed = await githubAppStatus(ctx)
    expect(installed).toMatchObject({ state: 'installed', installation: { hasToken: true } })
    expect(JSON.stringify(installed)).not.toContain(TOKEN)

    h.installation = snapshot({ account: { login: 'other', id: 1 } })
    expect((await githubAppStatus(ctx)).state).toBe('installed-elsewhere')

    store.set(PENDING, pendingRecord({ reason: 'busy' }))
    const pending = await githubAppStatus(ctx)
    expect(pending).toMatchObject({
      state: 'pending-apply',
      pending: { slug: APP.slug, reason: 'busy' },
    })
    expect(JSON.stringify(pending)).not.toContain('ENC[x]')
  })
})

describe('the callback', () => {
  const warned = () =>
    (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join('\n')

  it('redirects with the outcome and a code, relative, and without code, state or text', async () => {
    const { ctx } = fakeCtx()

    let state = await begin(ctx)
    stubGithub()
    const created = await githubCallback(ctx, request(`code=${CODE}&state=${state}`))
    expect(created.status).toBe(302)
    expect(location(created)).toBe('/settings?tab=integrations&github=created')

    state = await begin(ctx)
    stubGithub()
    h.apply = { ok: false, code: 'busy', reason: 'an apply is already running (building)' }
    const pending = await githubCallback(ctx, request(`code=${CODE}&state=${state}`))
    expect(location(pending)).toBe('/settings?tab=integrations&github=pending&reason=apply-refused')

    const failed = await githubCallback(ctx, request(`code=${CODE}&state=${state}`))
    expect(location(failed)).toBe('/settings?tab=integrations&github=failed&reason=state-mismatch')

    for (const r of [created, pending, failed]) {
      expect(location(r)).not.toContain('://')
      expect(location(r)).not.toContain(CODE)
      expect(location(r)).not.toContain(state)
      expect(location(r)).not.toContain('%20')
      expect(r.headers.get('referrer-policy')).toBe('no-referrer')
    }
  })

  it('keeps the detail in the server log, without the code or the state', async () => {
    const { ctx } = fakeCtx()
    const state = await begin(ctx)
    stubGithub()
    h.apply = { ok: false, code: 'busy', reason: 'an apply is already running (building)' }
    await githubCallback(ctx, request(`code=${CODE}&state=${state}`))
    await githubCallback(ctx, request(`code=${CODE}&state=${state}`))
    const log = warned()
    expect(log).toContain('(apply-refused)')
    expect(log).toContain('an apply is already running (building)')
    expect(log).toContain('(state-mismatch)')
    expect(log).not.toContain(CODE)
    expect(log).not.toContain(state)
    expect(leaks(log)).toEqual([])
  })

  it('answers unknown when finishing throws, and scrubs the error it logs', async () => {
    const { ctx } = fakeCtx()
    ctx.store.read = async () => {
      throw new Error(`database said ${CODE}`)
    }
    const r = await githubCallback(ctx, request(`code=${CODE}&state=x`))
    expect(r.status).toBe(302)
    expect(location(r)).toBe('/settings?tab=integrations&github=failed&reason=unknown')
    expect(warned()).toContain('database said [redacted]')
    expect(warned()).not.toContain(CODE)
  })

  it('puts only the code in the URL, and keeps log reasons to one short line', () => {
    const long = shortReason(`line one\nline\ttwo ${'x'.repeat(400)}`)
    expect(long.length).toBe(240)
    expect(long).not.toMatch(/[\n\t]/)
    expect(callbackLocation({ outcome: 'failed', code: 'seal-failed', reason: 'a&b=c <b>' })).toBe(
      '/settings?tab=integrations&github=failed&reason=seal-failed',
    )
  })
})
