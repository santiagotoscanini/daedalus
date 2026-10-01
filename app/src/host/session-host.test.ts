import { describe, expect, it } from 'vitest'
import type { ControllerClient } from './controller/client'
import { ControllerError, type RootRun, type SessionHostStatus } from './controller/wire'
import { readSessionHost, restartSessionHost, sessionHostLine } from './session-host'

// The session host's line and its restart, against fakes: the live controller
// is never asked anything here, and nothing is restarted.

const status = (over: Partial<SessionHostStatus> = {}): SessionHostStatus => ({
  state: 'running',
  version: '0.1.0',
  restartPending: false,
  livePtys: 3,
  connections: [
    { node: '0123456789abcdef', name: 'MacBook', count: 2 },
    { node: 'fedcba9876543210', name: null, count: 1 },
  ],
  error: null,
  ...over,
})

const client = (over: Partial<ControllerClient>) => over as unknown as ControllerClient

describe('the session host line', () => {
  it('names the version, the live terminals and each machine with its connections', () => {
    expect(sessionHostLine(status())).toEqual({
      chip: 'running',
      tone: 'ok',
      version: '0.1.0',
      facts: ['3 live terminals', 'MacBook (2), fedcba9876543210 (1)'],
      restartPending: false,
      confirm: 'Restarting the session host ends 3 live terminals.',
      error: null,
    })
  })

  it('says when nothing is connected, and that a restart then ends nothing', () => {
    const l = sessionHostLine(status({ livePtys: 0, connections: [] }))
    expect(l.facts).toEqual(['0 live terminals', 'no machine connected'])
    expect(l.confirm).toBe('No terminal is live, so restarting the session host ends nothing.')
    expect(sessionHostLine(status({ livePtys: 1 })).confirm).toBe(
      'Restarting the session host ends 1 live terminal.',
    )
  })

  it('reads every state, and counts no terminals on a host that is not up', () => {
    expect(sessionHostLine(status({ state: 'stale' }))).toMatchObject({
      chip: 'not answering',
      tone: 'warn',
    })
    const stopped = sessionHostLine(status({ state: 'stopped', livePtys: 0, connections: [] }))
    expect(stopped).toMatchObject({ chip: 'stopped', tone: 'bad', version: '0.1.0', facts: [] })
    const missing = sessionHostLine(
      status({ state: 'missing', version: null, livePtys: 0, connections: [] }),
    )
    expect(missing).toMatchObject({ chip: 'not running', tone: 'bad', facts: [] })
  })

  it('carries a pending update and the controller’s error', () => {
    const l = sessionHostLine(status({ restartPending: true, error: 'allow-list: read-only' }))
    expect(l.restartPending).toBe(true)
    expect(l.error).toBe('allow-list: read-only')
  })
})

describe('reading the session host', () => {
  it('is nothing on a box without one', async () => {
    const c = client({
      santreeStatus: () =>
        Promise.reject(new ControllerError('unsupported', 'no session host on this box')),
    })
    expect(await readSessionHost({ controller: c })).toBeNull()
  })

  it('is a line that says why when the controller cannot be asked', async () => {
    const c = client({
      santreeStatus: () => Promise.reject(new ControllerError('unreachable', 'no socket')),
    })
    expect(await readSessionHost({ controller: c })).toMatchObject({
      chip: 'unknown',
      tone: 'muted',
      error: 'no socket',
    })
  })

  it('is the line of what the controller answered', async () => {
    const c = client({ santreeStatus: () => Promise.resolve(status()) })
    expect((await readSessionHost({ controller: c }))?.chip).toBe('running')
  })
})

describe('restarting the session host', () => {
  it('asks the root helper for session-host-restart, with no selectors, past its 150 s', async () => {
    const asked: unknown[][] = []
    const c = client({
      rootRun: (...args: unknown[]) => {
        asked.push(args)
        return Promise.resolve<RootRun>({
          run: 'r1',
          verb: 'session-host-restart',
          outcome: 'done',
          detail: '',
          verbs: [],
        })
      },
    })
    expect(await restartSessionHost({ controller: c }, { actor: 'alice' })).toEqual({
      outcome: 'done',
      detail: '',
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.[0]).toBe('session-host-restart')
    expect(asked[0]?.[1]).toEqual({})
    expect(asked[0]?.[2]).toBeGreaterThan(150_000)
  })
})
