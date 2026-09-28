import { describe, expect, it } from 'vitest'
import type { ControllerClient } from '../../host/controller/client'
import { ControllerError } from '../../host/controller/wire'
import type { AgentRoster } from '../agent/roster'
import type { NodeClaude } from '../agent/status'
import { NO_ROSTER } from '../claude-roster'
import { mergeFacts, readControllerClaude, readRoster } from './claude'

/* ── the controller's side ──────────────────────────────────────────────── */

const report: NodeClaude = {
  path: '/nix/store/x-claude-code/bin/claude',
  installMethod: 'path',
  cliVersion: '2.1.281',
  lastUpdate: null,
  state: 'running',
  detail: null,
  pid: 4242,
  startedAt: '2026-09-28T01:00:00Z',
  restarts: 1,
  lastExit: null,
  server: { version: '2.1.280', environmentId: 'env_01', spawnMode: 'same-dir', maxSessions: 32 },
  sessions: [
    {
      pid: 10,
      transcriptId: 'a',
      remoteId: 'cse_1',
      cwd: '/etc/nixos',
      name: 'nixos-a',
      kind: 'bridge',
      entrypoint: null,
      version: '2.1.280',
      startedAt: 1,
      status: 'idle',
      lastActivityAt: 100,
      alive: true,
    },
    {
      pid: 11,
      transcriptId: 'b',
      remoteId: null,
      cwd: null,
      name: null,
      kind: null,
      entrypoint: null,
      version: null,
      startedAt: 2,
      status: null,
      lastActivityAt: null,
      alive: false,
    },
  ],
  credentials: {
    present: true,
    store: 'file',
    subscriptionType: 'max',
    rateLimitTier: null,
    expiresAt: 5,
    refreshExpiresAt: 6,
    scopes: ['user:inference'],
  },
  settings: { model: 'opus', effortLevel: null },
  user: 'santiago',
  home: '/home/santiago',
  workdir: '/etc/nixos',
  workdirVia: 'named',
  log: null,
  reportedAt: '2026-09-28T01:05:00Z',
}

const client = (claudeStatus: ControllerClient['claudeStatus']) =>
  ({ claudeStatus }) as unknown as ControllerClient

describe('reading Remote Control from the controller', () => {
  it('says "not run" when the controller does not offer it (before the cut-over)', async () => {
    const read = await readControllerClaude(
      client(() =>
        Promise.reject(
          new ControllerError('unsupported', 'this agent does not offer `claude.remote_control`'),
        ),
      ),
    )
    expect(read).toEqual({
      report: null,
      state: 'not-run',
      detail: 'Remote Control not run by the controller',
    })
  })

  it('says "no report" when it runs it and nothing is fresh', async () => {
    const read = await readControllerClaude(
      client(() => Promise.resolve({ reporting: false, wanted: true, report: null })),
    )
    expect(read.state).toBe('no-report')
  })

  it('says "unreachable" for any other failure, without throwing', async () => {
    const read = await readControllerClaude(
      client(() => Promise.reject(new ControllerError('unreachable', 'no socket'))),
    )
    expect(read.state).toBe('unreachable')
    expect(read.detail).toMatch(/no socket/)
  })
})

describe('the controller report and its roster, merged', () => {
  const roster: AgentRoster = {
    reportedAt: '2026-09-28T01:05:00Z',
    roster: NO_ROSTER,
    sessionStats: [
      { pid: 10, cpuMs: 7, rssBytes: 8, logBytes: 9, bridgeAt: 500 },
      { pid: 11, cpuMs: 1, rssBytes: 1, logBytes: 1, bridgeAt: 900 },
    ],
    server: { memoryBytes: 1024, cpuNsec: 2e9 },
    actions: [],
    truncated: false,
    errors: [],
  }

  it('takes the server from the report and the accounting from the roster', () => {
    const f = mergeFacts({ report, state: null, detail: null }, roster)
    expect(f.server).toEqual({
      state: 'running',
      detail: null,
      pid: 4242,
      startedAt: Date.parse('2026-09-28T01:00:00Z'),
      restarts: 1,
      memoryBytes: 1024,
      cpuNsec: 2e9,
    })
    expect(f.remote.environmentId).toBe('env_01')
    expect(f.cli.version).toBe('2.1.281')
    expect(f.credentials.scopes).toEqual(['user:inference'])
    expect(f.credentials.refreshExpiresAt).toBe(6)
  })

  it('joins live sessions to their stats by pid, and the later clock wins', () => {
    const f = mergeFacts({ report, state: null, detail: null }, roster)
    expect(f.sessions[0]).toMatchObject({ pid: 10, cpuMs: 7, rssBytes: 8, logBytes: 9 })
    expect(f.sessions[0]?.lastActivityAt).toBe(500)
    // A dead session takes no stats: its pid may be someone else's now.
    expect(f.sessions[1]).toMatchObject({ pid: 11, cpuMs: null, lastActivityAt: null })
  })

  it('keeps the report whole when there is no roster', () => {
    const f = mergeFacts({ report, state: null, detail: null }, null)
    expect(f.server.memoryBytes).toBeNull()
    expect(f.sessions[0]).toMatchObject({ pid: 10, cpuMs: null, lastActivityAt: 100 })
    expect(f.roster).toEqual(NO_ROSTER)
  })

  it('draws an honest empty server with no report, and keeps the roster', () => {
    const f = mergeFacts(
      { report: null, state: 'not-run', detail: 'Remote Control not run by the controller' },
      { ...roster, roster: { ...NO_ROSTER, transcriptTotal: 3 } },
    )
    expect(f.server.state).toBe('not-run')
    expect(f.server.memoryBytes).toBeNull()
    expect(f.sessions).toEqual([])
    expect(f.credentials.present).toBe(false)
    expect(f.roster.transcriptTotal).toBe(3)
  })
})

describe('reading a roster', () => {
  it('says why there is none when the session has not reported one', async () => {
    const r = await readRoster(() => Promise.resolve({ roster: null }), 'not yet')
    expect(r).toEqual({ roster: null, missing: 'not yet' })
  })

  it('says what the controller answered when it does not keep one, without throwing', async () => {
    const r = await readRoster(
      () => Promise.reject(new ControllerError('unknown_method', 'unknown method claude.roster')),
      'not yet',
    )
    expect(r).toEqual({ roster: null, missing: 'unknown method claude.roster' })
  })
})
