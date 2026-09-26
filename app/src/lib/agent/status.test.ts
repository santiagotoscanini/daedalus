import { describe, expect, it } from 'vitest'
import { agentStatus } from './status'

describe('agentStatus', () => {
  it('reads a status document', () => {
    const s = agentStatus({
      agent: 'daedalus-agent',
      version: '0.12.0',
      hostname: 'SANTI-PC',
      os: 'windows',
      uptime_secs: 80,
      os_uptime_secs: 635064,
      booted_at: '2026-09-15T09:31:11Z',
      awake_hold: false,
      hold_error: null,
      update_available: null,
      restart_pending: false,
      last_update_check: '2026-09-22T17:54:45Z',
      last_update_result: 'up to date',
      policy: { awake_hold: false, claude_remote_control: true },
      tray: { reporting: true, last_report: '2026-09-22T20:00:00Z' },
      claude: {
        state: 'running',
        cli_version: '2.1.276',
        server_version: '2.1.276',
        sessions: 2,
        started_at: '2026-09-22T19:00:00Z',
        signed_in: true,
      },
    })
    expect(s.hostname).toBe('SANTI-PC')
    expect(s.osUptimeSecs).toBe(635064)
    expect(s.policy.awakeHold).toBe(false)
    expect(s.trayReporting).toBe(true)
    expect(s.claude?.sessions).toBe(2)
    expect(s.claude?.signedIn).toBe(true)
  })

  it('decodes a field the document lacks to its fallback', () => {
    const s = agentStatus({ version: '0.12.0', hostname: 'X' })
    expect(s.osUptimeSecs).toBeNull()
    expect(s.bootedAt).toBeNull()
    expect(s.lastUpdateResult).toBeNull()
    expect(s.policy).toEqual({ awakeHold: true, claudeRemoteControl: false })
    expect(s.claude).toBeNull()
    expect(s.trayReporting).toBe(false)
  })

  it('refuses a body without a version', () => {
    expect(() => agentStatus({ hostname: 'X' })).toThrow()
  })
})

describe('nodeClaudeReport', () => {
  it('reads the full report behind the token, including a Keychain login', async () => {
    const { nodeClaudeReport } = await import('./status')
    const r = nodeClaudeReport({
      path: '/Users/x/.local/bin/claude',
      install_method: 'native',
      cli_version: '2.1.260',
      state: 'running',
      pid: 1234,
      started_at: '2026-09-22T19:00:00Z',
      restarts: 1,
      server: {
        version: '2.1.260',
        environment_id: 'env_1',
        spawn_mode: 'same-dir',
        max_sessions: 32,
      },
      sessions: [{ pid: 9, name: 'x-ab', alive: true, started_at: 1790000000000 }],
      credentials: { present: true, store: 'keychain' },
      settings: { model: 'opus' },
      workdir: '/Users/x/dev/p',
      workdir_via: 'most recent trusted project',
      reported_at: '2026-09-22T20:00:00Z',
    })
    expect(r?.installMethod).toBe('native')
    expect(r?.server.environmentId).toBe('env_1')
    expect(r?.sessions[0]?.name).toBe('x-ab')
    expect(r?.credentials.store).toBe('keychain')
    expect(r?.credentials.refreshExpiresAt).toBeNull()
    expect(r?.workdirVia).toBe('most recent trusted project')
    expect(nodeClaudeReport(null)).toBeNull()
  })
})
