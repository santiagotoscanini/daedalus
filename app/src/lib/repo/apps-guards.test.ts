import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BASE_DOMAIN } from '../hostname'

// The checks on the way INTO the registry, as opposed to apps.test.ts's pure
// half on the way out.
//
// Both of these rules exist because Nix enforces them too late to be useful:
//
//   A colliding hostname is a hard Nix failure — fleet.traefikRoutes refuses
//   two routers on one entrypoint+host — and lib/hostname.ts says where that
//   failure lands: "mid-Apply, after the commit", so the recovery is a revert.
//   The form checks it too, but a form is not a boundary; these two functions
//   are.
//
//   A forward-auth gate lands in the same place by two other doors:
//   platform/publishing.nix asserts `auth == "oidc" -> healthPath != null`
//   (without one the middleware 302s every gatus probe to the IdP, and a probe
//   passes on anything under 500 — the gate would certify itself), and
//   stacks/apps/apps.nix asserts `proxyAuth -> exposed`. Both fire inside the
//   rebuild an Apply has already committed. So these checks are the difference
//   between a red field on a form and a revert on the box.
//
// The database is mocked at the module boundary rather than redirected: what
// is being tested is which writes are REFUSED, so the assertions are over the
// rows that reached the fake, and a real connection would only add a way for
// this to touch the box's own registry.

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  /** listApps — the names already in the registry. */
  apps: [] as { name: string }[],
  /** getApp — the one record under test. */
  record: null as Row | null,
  /** Hostnames published from this box, as the Nix manifest reports them. */
  taken: [] as string[],
  /** Hand-written entries: names Nix owns that are not registry rows. */
  manifest: [] as { name: string }[],
  inserted: [] as Row[],
  updated: [] as Row[],
}))

vi.mock('../../host/db', () => ({
  db: {
    query: {
      apps: {
        findMany: async () => h.apps,
        findFirst: async () => h.record ?? undefined,
      },
    },
    insert: () => ({
      values: async (row: Row) => {
        h.inserted.push(row)
      },
    }),
    update: () => ({
      set: (row: Row) => ({
        where: async () => {
          h.updated.push(row)
        },
      }),
    }),
  },
}))

vi.mock('../../host/nix-manifest', () => ({
  manifestEntries: async () => h.manifest,
  // The real one filters the caller's own hostname out of the taken list,
  // which is the whole reason an app can keep the name it already has.
  hostnamesTakenBy: async (others: string) => h.taken.filter((x) => x !== others),
}))

const { createApp, updateApp } = await import('./apps')

const host = (label: string) => `${label}.${BASE_DOMAIN}`

const newApp = (over: Partial<Parameters<typeof createApp>[0]> = {}) => ({
  name: 'voyra',
  description: 'a new one',
  stage: 'live' as const,
  postgres: false,
  storage: false,
  litellm: false,
  prometheus: false,
  image: null,
  hostname: null,
  ...over,
})

const record = (over: Row = {}): Row => ({
  id: 'app-1',
  name: 'voyra',
  managedInNix: false,
  stage: 'live',
  hostname: null,
  authMode: 'none',
  authHealthPath: null,
  envVars: [],
  ...over,
})

beforeEach(() => {
  h.apps = []
  h.record = null
  h.taken = []
  h.manifest = []
  h.inserted = []
  h.updated = []
})

describe('createApp re-checks the hostname', () => {
  it('refuses one the box already publishes, and inserts nothing', async () => {
    h.taken = [host('films')]

    await expect(createApp(newApp({ hostname: host('films') }))).rejects.toThrow(
      /already published by something else/,
    )
    expect(h.inserted).toEqual([])
  })

  // The collision is with what Nix will publish, which for an app that names
  // no hostname is the one derived from its name — so the check has to run on
  // the derived value rather than on the empty field the caller sent.
  it('refuses when the DERIVED default hostname is taken', async () => {
    h.taken = [host('voyra')]

    await expect(createApp(newApp({ name: 'voyra', hostname: null }))).rejects.toThrow(
      /already published by something else/,
    )
    expect(h.inserted).toEqual([])
  })

  it('creates when the hostname is free', async () => {
    h.taken = [host('films')]

    expect(await createApp(newApp({ hostname: ` ${host('VOYRA')} ` }))).toEqual({ name: 'voyra' })
    expect(h.inserted).toHaveLength(1)
    expect(h.inserted[0]).toMatchObject({ name: 'voyra', hostname: host('voyra') })
  })
})

describe('updateApp re-checks the hostname', () => {
  it('refuses one another app already publishes, and updates nothing', async () => {
    h.record = record({ name: 'voyra', hostname: null })
    h.taken = [host('voyra'), host('films')]

    await expect(updateApp('voyra', { hostname: host('films') })).rejects.toThrow(
      /already published by something else/,
    )
    expect(h.updated).toEqual([])
  })

  // Its own hostname is in the taken list — it is the thing publishing it —
  // so an app saving its page without touching the field must not collide
  // with itself.
  it('lets an app keep the hostname it already has', async () => {
    h.record = record({ name: 'voyra', hostname: host('films') })
    h.taken = [host('films')]

    await updateApp('voyra', { hostname: ` ${host('FILMS')} ` })
    expect(h.updated).toHaveLength(1)
    expect(h.updated[0]).toMatchObject({ hostname: host('films') })
  })

  // Same rule one step further out: an app with no override publishes its
  // derived default, so typing that default in is still not a collision.
  it('lets an app name its own default hostname explicitly', async () => {
    h.record = record({ name: 'voyra', hostname: null })
    h.taken = [host('voyra')]

    await updateApp('voyra', { hostname: host('voyra') })
    expect(h.updated).toHaveLength(1)
    expect(h.updated[0]).toMatchObject({ hostname: host('voyra') })
  })
})

describe('forward auth needs an ingress and a health path', () => {
  it('refuses proxy mode with no health path', async () => {
    h.record = record({ authMode: 'none', authHealthPath: null, stage: 'live' })

    await expect(updateApp('voyra', { authMode: 'proxy' })).rejects.toThrow(/needs a health path/)
    expect(h.updated).toEqual([])
  })

  // The dangerous direction, because it happens to an app that is already
  // live and already green: take the health path away and the probe starts
  // certifying the login redirect instead of the app.
  it('refuses clearing the health path out from under a gated app', async () => {
    for (const authHealthPath of [null, '   ']) {
      h.record = record({ authMode: 'proxy', authHealthPath: '/api/healthz', stage: 'live' })
      await expect(updateApp('voyra', { authHealthPath })).rejects.toThrow(/needs a health path/)
      expect(h.updated).toEqual([])
    }
  })

  it('refuses gating an app that has no ingress to gate', async () => {
    h.record = record({ authMode: 'none', authHealthPath: '/api/healthz', stage: 'off' })

    await expect(updateApp('voyra', { authMode: 'proxy' })).rejects.toThrow(/needs an ingress/)
    expect(h.updated).toEqual([])
  })

  it('refuses taking the ingress away from a gated app', async () => {
    h.record = record({ authMode: 'proxy', authHealthPath: '/api/healthz', stage: 'live' })

    await expect(updateApp('voyra', { stage: 'off' })).rejects.toThrow(/needs an ingress/)
    expect(h.updated).toEqual([])
  })

  it('accepts the gate when both halves arrive in one patch', async () => {
    h.record = record({ authMode: 'none', authHealthPath: null, stage: 'live' })

    await updateApp('voyra', { authMode: 'proxy', authHealthPath: '/api/healthz' })
    expect(h.updated).toHaveLength(1)
    expect(h.updated[0]).toMatchObject({ authMode: 'proxy', authHealthPath: '/api/healthz' })
  })
})
