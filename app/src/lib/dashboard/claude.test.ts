import { describe, expect, it } from 'vitest'
import { type FakeAnswers, fakeController } from '../../host/controller/fake'
import type { Report, Roster } from '../../host/controller/generated'
import { ControllerError } from '../../host/controller/wire'
import { mergeFacts, readControllerClaude, readRoster } from './claude'

/* ── the controller's side ──────────────────────────────────────────────── */

const report: Report = {
  path: '/nix/store/x-claude-code/bin/claude',
  install_method: 'path',
  cli_version: '2.1.281',
  last_update: null,
  state: 'running',
  detail: null,
  pid: 4242,
  started_at: '2026-09-28T01:00:00Z',
  restarts: 1,
  last_exit: null,
  server: {
    version: '2.1.280',
    environment_id: 'env_01',
    spawn_mode: 'same-dir',
    max_sessions: 32,
  },
  sessions: [
    {
      pid: 10,
      transcript_id: 'a',
      remote_id: 'cse_1',
      cwd: '/etc/nixos',
      name: 'nixos-a',
      kind: 'bridge',
      entrypoint: null,
      version: '2.1.280',
      started_at: 1,
      status: 'idle',
      last_activity_at: 100,
      alive: true,
    },
    {
      pid: 11,
      transcript_id: 'b',
      remote_id: null,
      cwd: null,
      name: null,
      kind: null,
      entrypoint: null,
      version: null,
      started_at: 2,
      status: null,
      last_activity_at: null,
      alive: false,
    },
  ],
  recovered: [],
  credentials: {
    present: true,
    store: 'file',
    subscription_type: 'max',
    rate_limit_tier: null,
    expires_at: 5,
    refresh_expires_at: 6,
    scopes: ['user:inference'],
  },
  settings: { model: 'opus', effort_level: null },
  user: 'santiago',
  home: '/home/santiago',
  workdir: '/etc/nixos',
  workdir_via: 'named',
  log: null,
  job: 'daedalus-claude-rc',
  reported_at: '2026-09-28T01:05:00Z',
}

const client = (status: FakeAnswers['claude.status']) => fakeController({ 'claude.status': status })

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
  const roster: Roster = {
    reported_at: '2026-09-28T01:05:00Z',
    agents_available: false,
    agents: [],
    transcripts: [],
    transcript_total: 0,
    empty_count: 0,
    truncated: false,
    managed: [],
    session_stats: [
      { pid: 10, cpu_ms: 7, rss_bytes: 8, log_bytes: 9, bridge_at: 500 },
      { pid: 11, cpu_ms: 1, rss_bytes: 1, log_bytes: 1, bridge_at: 900 },
    ],
    server: { memory_bytes: 1024, cpu_nsec: 2e9 },
    actions: [],
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
    expect(f.remote.environment_id).toBe('env_01')
    expect(f.cli.version).toBe('2.1.281')
    expect(f.credentials.scopes).toEqual(['user:inference'])
    expect(f.credentials.refresh_expires_at).toBe(6)
  })

  it('joins live sessions to their stats by pid, and the later clock wins', () => {
    const f = mergeFacts({ report, state: null, detail: null }, roster)
    expect(f.sessions[0]).toMatchObject({ pid: 10, cpu_ms: 7, rss_bytes: 8, log_bytes: 9 })
    expect(f.sessions[0]?.last_activity_at).toBe(500)
    // A dead session takes no stats: its pid may be someone else's now.
    expect(f.sessions[1]).toMatchObject({ pid: 11, cpu_ms: null, last_activity_at: null })
  })

  it('keeps the report whole when there is no roster', () => {
    const f = mergeFacts({ report, state: null, detail: null }, null)
    expect(f.server.memoryBytes).toBeNull()
    expect(f.sessions[0]).toMatchObject({ pid: 10, cpu_ms: null, last_activity_at: 100 })
    expect(f.roster).toBeNull()
  })

  it('draws an honest empty server with no report, and keeps the roster', () => {
    const f = mergeFacts(
      { report: null, state: 'not-run', detail: 'Remote Control not run by the controller' },
      { ...roster, transcript_total: 3 },
    )
    expect(f.server.state).toBe('not-run')
    expect(f.server.memoryBytes).toBeNull()
    expect(f.sessions).toEqual([])
    expect(f.credentials.present).toBe(false)
    expect(f.roster?.transcript_total).toBe(3)
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
