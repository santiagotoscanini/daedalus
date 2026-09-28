import { describe, expect, it } from 'vitest'
import type { ControllerClient } from '../../host/controller/client'
import { ControllerError } from '../../host/controller/wire'
import type { NodeClaude } from '../agent/status'
import { NO_ROSTER } from '../claude-roster'
import { DecodeError } from '../contract/decode'
import { factsShape, mergeFacts, readControllerClaude } from './claude'

// The snapshot now carries only what the controller cannot: the roster, the
// unit's accounting, per-session CPU/RSS/log, the login's scopes. Its decoder
// must take a file the CURRENT host script did not write — between a rebuild
// and the next timer tick the file on disk is the previous script's.

describe('a snapshot written by an older script', () => {
  it('decodes to empty defaults, ignoring the keys it no longer reads', () => {
    const facts = factsShape(
      { service: { activeState: 'active' }, sessions: [], cli: { version: '2.1.260' } },
      '',
    )
    expect(facts.roster).toEqual(NO_ROSTER)
    expect(facts.unit).toEqual({ memoryBytes: null, cpuNsec: null })
    expect(facts.sessionStats).toEqual([])
    expect(facts.scopes).toEqual([])
  })
})

describe('a roster the current script wrote', () => {
  it('fills in every field the script may have left out', () => {
    const facts = factsShape(
      {
        roster: {
          agentsAvailable: true,
          agents: [{ id: '3ab35c23', kind: 'background' }],
          transcripts: [{ id: '63a9d108-9cb0-52ce-a893-2100b396d0e6' }],
        },
      },
      '',
    )
    expect(facts.roster.agents[0]).toEqual({
      id: '3ab35c23',
      sessionId: null,
      pid: null,
      kind: 'background',
      state: null,
      status: null,
      name: null,
      cwd: null,
      startedAt: null,
    })
    expect(facts.roster.transcripts[0]?.sizeBytes).toBe(0)
    expect(facts.roster.transcripts[0]?.startedAt).toBeNull()
    expect(facts.roster.transcriptTotal).toBe(0)
  })

  it('refuses a transcript with no id, which is the one field that is not a label', () => {
    expect(() => factsShape({ roster: { transcripts: [{ cwd: '/etc/nixos' }] } }, '')).toThrow(
      DecodeError,
    )
  })

  it('names the path of a field of the wrong type', () => {
    expect(() => factsShape({ roster: { transcripts: [{ id: 5 }] } }, '')).toThrow(
      /roster\.transcripts\[0\]\.id/,
    )
  })
})

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
      detail: 'Remote Control not run by the controller yet',
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

describe('the controller report and the snapshot, merged', () => {
  const snap = {
    unit: { memoryBytes: 1024, cpuNsec: 2e9 },
    sessionStats: [
      { pid: 10, cpuMs: 7, rssBytes: 8, logBytes: 9, bridgeAt: 500 },
      { pid: 11, cpuMs: 1, rssBytes: 1, logBytes: 1, bridgeAt: 900 },
    ],
    roster: NO_ROSTER,
    scopes: ['user:inference'],
  }

  it('takes the server from the report and the accounting from the snapshot', () => {
    const f = mergeFacts({ report, state: null, detail: null }, snap)
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
    const f = mergeFacts({ report, state: null, detail: null }, snap)
    expect(f.sessions[0]).toMatchObject({ pid: 10, cpuMs: 7, rssBytes: 8, logBytes: 9 })
    expect(f.sessions[0]?.lastActivityAt).toBe(500)
    // A dead session takes no stats: its pid may be someone else's now.
    expect(f.sessions[1]).toMatchObject({ pid: 11, cpuMs: null, lastActivityAt: null })
  })

  it('draws an honest empty server with no report, and keeps the roster', () => {
    const roster = { ...NO_ROSTER, transcriptTotal: 3 }
    const f = mergeFacts(
      { report: null, state: 'not-run', detail: 'Remote Control not run by the controller yet' },
      { ...snap, roster },
    )
    expect(f.server.state).toBe('not-run')
    expect(f.server.memoryBytes).toBeNull()
    expect(f.sessions).toEqual([])
    expect(f.credentials.present).toBe(false)
    expect(f.roster.transcriptTotal).toBe(3)
  })
})
