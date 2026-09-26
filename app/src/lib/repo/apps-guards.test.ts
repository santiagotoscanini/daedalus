import { beforeEach, describe, expect, it, vi } from 'vitest'

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
//   nix/modules/apps/apps.nix asserts `proxyAuth -> exposed`. Both fire inside the
//   rebuild an Apply has already committed. So these checks are the difference
//   between a red field on a form and a revert on the box.
//
// The database is mocked at the module boundary rather than redirected: what
// is being tested is which writes are REFUSED, so the assertions are over the
// rows that reached the fake, and a real connection would only add a way for
// this to touch the box's own registry.

type Row = Record<string, unknown>

// The repo reads the box's domain at use (host/site.ts), so a stubbed env is
// the whole fixture.
const BASE_DOMAIN = 'box.test'
vi.stubEnv('BASE_DOMAIN', BASE_DOMAIN)

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
  /** Task rows the transaction inserted, and how many times it cleared them. */
  insertedTasks: [] as Row[],
  taskDeletes: 0,
}))

// `updateApp` writes inside a transaction — the column UPDATE and the task
// rows land together or not at all — so the fake has to offer one. The handle
// it hands the callback records the same way the outer fake does, which is
// what lets a test assert that a refusal wrote NOTHING: no column set, no task
// row inserted, and no delete of the rows that were there.
const tx = {
  update: () => ({
    set: (row: Row) => ({
      where: async () => {
        h.updated.push(row)
      },
    }),
  }),
  delete: () => ({
    where: async () => {
      h.taskDeletes += 1
    },
  }),
  insert: () => ({
    values: async (rows: Row[]) => {
      h.insertedTasks.push(...rows)
    },
  }),
}

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
    transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  },
}))

vi.mock('../../host/nix-manifest', () => ({
  manifestEntries: async () => h.manifest,
  // The real one filters the caller's own hostname out of the taken list,
  // which is the whole reason an app can keep the name it already has.
  hostnamesTakenBy: async (others: string) => h.taken.filter((x) => x !== others),
}))

const { createApp, updateApp, validateAppPatch } = await import('./apps')

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
  h.insertedTasks = []
  h.taskDeletes = 0
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

// The scheduled-tasks half of the same boundary. Every rule below is also an
// assertion in nix/modules/apps/apps.nix — and that one fires inside the rebuild an
// Apply has already committed, so it costs a revert. These tests are what says
// the cheap refusal happens first, and that a refused patch writes NOTHING:
// no column set, no task row inserted, and crucially no delete of the rows the
// app already had (the write is delete-then-insert, so a half-applied refusal
// would be a silent un-scheduling).
describe('tasks in a patch', () => {
  const save = async (tasks: unknown) =>
    updateApp('voyra', validateAppPatch({ tasks } as Record<string, unknown>))

  const task = (over: Row = {}) => ({
    id: 'digest',
    schedule: '*-*-* 04:23:00',
    command: ['node', 'scripts/digest.mjs'],
    timeoutSec: 900,
    ...over,
  })

  const refuses = async (tasks: unknown, sentence: RegExp) => {
    h.record = record()
    await expect(save(tasks)).rejects.toThrow(sentence)
    expect(h.updated).toEqual([])
    expect(h.insertedTasks).toEqual([])
    expect(h.taskDeletes).toBe(0)
  }

  it('writes the rows in authored order, with position as the only thing that keeps it', async () => {
    h.record = record()

    await save([
      task(),
      task({
        id: 'prune',
        schedule: '*:41:00',
        command: ['bin/prune', '--older-than', '30d'],
        timeoutSec: 120,
      }),
    ])

    expect(h.taskDeletes).toBe(1)
    expect(h.insertedTasks).toEqual([
      {
        appId: 'app-1',
        taskId: 'digest',
        schedule: '*-*-* 04:23:00',
        command: ['node', 'scripts/digest.mjs'],
        timeoutSec: 900,
        position: 0,
      },
      {
        appId: 'app-1',
        taskId: 'prune',
        schedule: '*:41:00',
        command: ['bin/prune', '--older-than', '30d'],
        timeoutSec: 120,
        position: 1,
      },
    ])
    // The record itself is still touched: `updatedAt` is when this app last
    // changed, and its tasks are part of it.
    expect(h.updated).toHaveLength(1)
  })

  it('clears the rows when the last task is removed, and inserts none', async () => {
    h.record = record()

    await save([])

    expect(h.taskDeletes).toBe(1)
    expect(h.insertedTasks).toEqual([])
  })

  it('leaves the rows alone when the patch does not mention tasks', async () => {
    h.record = record()

    await updateApp('voyra', { description: 'still voyra' })

    expect(h.taskDeletes).toBe(0)
    expect(h.insertedTasks).toEqual([])
    expect(h.updated).toHaveLength(1)
  })

  it('refuses an id outside the unit-name charset', async () => {
    for (const id of ['With Space', 'dots.are.units', 'under_score', '-leading', 'a'.repeat(41)]) {
      await refuses([task({ id })], /systemd unit name/)
    }
  })

  it('refuses two tasks sharing an id — one id is one unit', async () => {
    await refuses([task(), task()], /already a task on this app/)
  })

  it('refuses an empty command, and an empty argument inside one', async () => {
    await refuses([task({ command: [] })], /give it something to run/)
    await refuses([task({ command: ['node', '  '] })], /argument 2 is empty/)
    await refuses([task({ command: 'node scripts/digest.mjs' })], /argv, not a shell line/)
    await refuses([task({ command: ['node', 7] })], /argv, not a shell line/)
  })

  it('refuses a timeout that is not a positive whole number of seconds', async () => {
    for (const timeoutSec of [0, -1, 1.5]) {
      await refuses([task({ timeoutSec })], /whole number of seconds above zero/)
    }
    await refuses([task({ timeoutSec: '900' })], /must be a number of seconds/)
  })

  it('refuses an empty schedule', async () => {
    await refuses([task({ schedule: '   ' })], /pick a schedule first/)
  })

  // The one that is not about typing: `hourly` is a perfectly valid systemd
  // calendar, and that is the problem — it elapses at :00, inside myspeed's
  // house-wide DNS blackout, where a starved run can still report success.
  it('refuses every systemd shorthand, however valid systemd finds it', async () => {
    for (const schedule of ['hourly', 'daily', 'weekly', 'monthly', 'minutely', 'yearly']) {
      await refuses([task({ schedule })], /fires exactly on the hour/)
    }
    await refuses([task({ schedule: 'Daily' })], /fires exactly on the hour/)
  })

  it('refuses a tasks value that is not a list of tasks at all', async () => {
    await refuses('digest', /must be an array of scheduled tasks/)
    await refuses([null], /must be an object with id, schedule, command and timeoutSec/)
    await refuses([{ schedule: '*:41:00' }], /id must be a string/)
  })
})
