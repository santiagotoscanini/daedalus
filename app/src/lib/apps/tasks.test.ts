import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../core/ctx'

// The Tasks tab's two jobs, and the part of each that would fail silently.
//
// `runAppTaskNow` asks for a run that ROOT starts: the host derives a
// unit name from what this function lets through and starts it. So the
// assertions here are over what actually reached the host — a refusal that
// still asked, or a request naming a task the app never
// declared, is the bug this file exists to keep dead. Checking only the thrown
// message would pass either way.
//
// `loadTasksTab` joins declared tasks to the host snapshot's timer table. The
// failure mode there is the opposite of loud: systemd reports success and exit
// 0 for a service that has never started, so a task that has never run must
// come back with NO outcome rather than a green one.

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  record: null as Row | null,
  jobs: [] as Record<string, unknown>[],
  /** Everything that reached the host. Empty is the assertion for a refusal. */
  requested: [] as Record<string, unknown>[],
}))

vi.mock('../repo/apps', () => ({
  getApp: async () => h.record ?? undefined,
}))

vi.mock('../../host/task-run', () => ({
  requestTaskRun: async (_ctx: unknown, body: Record<string, unknown>) => {
    h.requested.push(body)
    return { outcome: 'done', detail: 'ran' }
  },
}))

vi.mock('../dashboard/host-facts', () => ({ hostFacts: async () => ({ jobs: h.jobs }) }))

const { loadTasksTab, runAppTaskNow } = await import('./tasks')

const CTX = {} as Pick<Ctx, 'controller'>
const ACTOR = 'someone@example.com'

const task = (taskId: string, over: Row = {}) => ({
  taskId,
  schedule: '*-*-* 04:23:00',
  command: ['node', 'scripts/digest.mjs'],
  timeoutSec: 900,
  ...over,
})

beforeEach(() => {
  h.record = { name: 'hermes', stage: 'live', tasks: [task('digest')] }
  h.jobs = []
  h.requested = []
})

describe('runAppTaskNow', () => {
  it('asks for the app, the task and the actor, and returns the host answer', async () => {
    expect(await runAppTaskNow(CTX, { name: 'hermes', task: 'digest', actor: ACTOR })).toEqual({
      outcome: 'done',
      detail: 'ran',
    })
    expect(h.requested).toEqual([{ app: 'hermes', task: 'digest', actor: 'someone@example.com' }])
  })

  // The one that matters: an id can pass the charset and still name no unit.
  // If this ever published, the host would be asked to start a unit that does
  // not exist, on a name daedalus never generated.
  it('refuses a task the app does not declare, and publishes nothing', async () => {
    await expect(
      runAppTaskNow(CTX, { name: 'hermes', task: 'not-a-task', actor: ACTOR }),
    ).rejects.toThrow('declares no task called not-a-task')
    expect(h.requested).toEqual([])
  })

  it('refuses an app not set up yet — there is no container to exec into', async () => {
    h.record = { name: 'hermes', stage: 'lab', awaitingImage: true, tasks: [task('digest')] }
    await expect(
      runAppTaskNow(CTX, { name: 'hermes', task: 'digest', actor: ACTOR }),
    ).rejects.toThrow('not set up yet')
    expect(h.requested).toEqual([])
  })

  it('refuses an app that is not in the registry at all', async () => {
    h.record = null
    await expect(
      runAppTaskNow(CTX, { name: 'ghost', task: 'digest', actor: ACTOR }),
    ).rejects.toThrow('no app named')
    expect(h.requested).toEqual([])
  })
})

describe('loadTasksTab', () => {
  it('reports no outcome for a task that has never run', async () => {
    // systemd's defaults, exactly as the snapshot carries them: a timer that
    // has not fired still says success/0.
    h.jobs = [
      {
        timer: 'app-hermes-task-digest.timer',
        service: 'app-hermes-task-digest.service',
        nextAt: 1_800_000_000,
        lastAt: null,
        result: 'success',
        exitStatus: 0,
      },
    ]
    const [row] = (await loadTasksTab('hermes')).tasks
    expect(row).toBeDefined()
    expect(row?.result).toBeNull()
    expect(row?.exitStatus).toBeNull()
    expect(row?.lastRunAt).toBeNull()
    // The next elapse is real even with no history, and is the useful half.
    expect(row?.nextRunAt).toBe(new Date(1_800_000_000 * 1000).toISOString())
  })

  it('carries a real run’s outcome, matched on the unit name it generates', async () => {
    h.jobs = [
      {
        timer: 'app-hermes-task-digest.timer',
        service: 'app-hermes-task-digest.service',
        nextAt: 1_800_000_000,
        lastAt: 1_700_000_000,
        result: 'exit-code',
        exitStatus: 2,
      },
    ]
    const [row] = (await loadTasksTab('hermes')).tasks
    expect(row?.unit).toBe('app-hermes-task-digest')
    expect(row?.result).toBe('exit-code')
    expect(row?.exitStatus).toBe(2)
    expect(row?.lastRunAt).toBe(new Date(1_700_000_000 * 1000).toISOString())
  })

  it('reads 0 as “never”, not as 1970', async () => {
    h.jobs = [
      {
        timer: 'app-hermes-task-digest.timer',
        service: null,
        nextAt: 0,
        lastAt: 0,
        result: 'success',
        exitStatus: 0,
      },
    ]
    const [row] = (await loadTasksTab('hermes')).tasks
    expect(row?.lastRunAt).toBeNull()
    expect(row?.nextRunAt).toBeNull()
  })

  // Before the Apply that ships a task, nix has generated no unit for it, so
  // the snapshot knows nothing. The row must still render.
  it('renders a declared task the host has no timer for yet', async () => {
    const payload = await loadTasksTab('hermes')
    expect(payload.running).toBe(true)
    expect(payload.tasks).toHaveLength(1)
    expect(payload.tasks[0]?.lastRunAt).toBeNull()
    expect(payload.tasks[0]?.scheduleText).toBe('Every day, at 04:23')
    expect(payload.tasks[0]?.schedule).toBe('*-*-* 04:23:00')
  })

  it('says an app is not running before it is set up', async () => {
    h.record = { name: 'hermes', stage: 'lab', awaitingImage: true, tasks: [task('digest')] }
    expect((await loadTasksTab('hermes')).running).toBe(false)
  })

  it('answers an empty tab for a name the registry does not know', async () => {
    h.record = null
    expect(await loadTasksTab('ghost')).toEqual({ tasks: [], running: false })
  })
})
