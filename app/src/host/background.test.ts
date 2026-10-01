import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The process's background work starts once, from process start, and stops at
// shutdown — never from a request. The scheduler once started from
// /api/healthz alone, so a box without gatus probing it never dispatched a
// build; the last test here holds the probe to answering and nothing else.

const h = vi.hoisted(() => ({
  calls: [] as string[],
  envFatal: false,
}))

const note = (name: string) => () => {
  h.calls.push(name)
}

vi.mock('../core/builds/scheduler', () => ({
  ensureScheduler: note('ensureScheduler'),
  stopScheduler: note('stopScheduler'),
}))
vi.mock('./gateway-sync', () => ({
  ensureGatewaySync: note('ensureGatewaySync'),
  stopGatewaySync: note('stopGatewaySync'),
}))
vi.mock('./workspace-icons', () => ({
  ensureIconExport: note('ensureIconExport'),
  stopIconExport: note('stopIconExport'),
}))
vi.mock('./env', () => ({
  reportEnvOnce: () => {
    h.calls.push('reportEnvOnce')
    if (h.envFatal) throw new Error('DATABASE_URL is required')
  },
}))
vi.mock('./controller/nodes', () => ({
  ensureControllerLink: async () => {
    h.calls.push('ensureControllerLink')
  },
}))
vi.mock('../core/ctx', () => ({ makeCtx: async () => ({}) }))
vi.mock('../core/local-login', () => ({
  announceSetupTokenOnce: async () => {
    h.calls.push('announceSetupTokenOnce')
    return 'off'
  },
}))
vi.mock('./db', () => ({
  sql: async () => [{ '?column?': 1 }],
}))

const SLOT = Symbol.for('daedalus.background')
const g = globalThis as unknown as Record<symbol, unknown>

const count = (name: string) => h.calls.filter((c) => c === name).length

beforeEach(() => {
  vi.useFakeTimers()
  h.calls = []
  h.envFatal = false
})

afterEach(async () => {
  const { stop } = await import('./background')
  stop()
  vi.useRealTimers()
})

describe('the background work', () => {
  it('starts everything once, however often start is called', async () => {
    const { start } = await import('./background')
    start()
    start()
    start()
    await vi.advanceTimersByTimeAsync(0)
    for (const name of [
      'reportEnvOnce',
      'ensureScheduler',
      'ensureGatewaySync',
      'ensureIconExport',
      'ensureControllerLink',
      'announceSetupTokenOnce',
    ]) {
      expect(count(name), name).toBe(1)
    }
    expect(vi.getTimerCount()).toBe(1)
  })

  it('keeps the controller link on its minute', async () => {
    const { CONTROLLER_LINK_EVERY_MS, start } = await import('./background')
    start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(CONTROLLER_LINK_EVERY_MS * 3)
    expect(count('ensureControllerLink')).toBe(4)
  })

  it('stops everything once, and leaves no timer', async () => {
    const { start, stop } = await import('./background')
    start()
    stop()
    stop()
    for (const name of ['stopScheduler', 'stopGatewaySync', 'stopIconExport']) {
      expect(count(name), name).toBe(1)
    }
    expect(vi.getTimerCount()).toBe(0)
    expect(g[SLOT]).toBeUndefined()
  })

  it('does nothing on a stop before any start', async () => {
    const { stop } = await import('./background')
    stop()
    expect(h.calls).toEqual([])
  })

  it('starts again after a stop', async () => {
    const { start, stop } = await import('./background')
    start()
    stop()
    start()
    expect(count('ensureScheduler')).toBe(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('survives a re-evaluation of its module without starting twice', async () => {
    const first = await import('./background')
    first.start()
    vi.resetModules()
    const again = await import('./background')
    again.start()
    expect(count('ensureScheduler')).toBe(1)
    again.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('refuses to start on a missing required variable, and starts nothing', async () => {
    h.envFatal = true
    const { start } = await import('./background')
    expect(() => start()).toThrow('DATABASE_URL is required')
    expect(h.calls).toEqual(['reportEnvOnce'])
    expect(g[SLOT]).toBeUndefined()
  })
})

describe('/api/healthz', () => {
  it('answers readiness and starts nothing', async () => {
    type Handler = () => Promise<Response>
    type RouteLike = { options?: { server?: { handlers?: { GET?: Handler } } } }
    const { Route } = (await import('../routes/api.healthz')) as { Route: RouteLike }
    const get = Route.options?.server?.handlers?.GET
    if (!get) throw new Error('/api/healthz has no GET handler')
    const res = await get()
    await vi.advanceTimersByTimeAsync(0)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(h.calls).toEqual([])
    expect(g[SLOT]).toBeUndefined()
  })
})
