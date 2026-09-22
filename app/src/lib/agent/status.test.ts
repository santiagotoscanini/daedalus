import { describe, expect, it } from 'vitest'
import { agentStatus } from './status'

describe('agentStatus', () => {
  it('reads a 0.2.1 document', () => {
    const s = agentStatus({
      agent: 'daedalus-agent',
      version: '0.2.1',
      hostname: 'SANTI-PC',
      os: 'windows',
      uptime_secs: 80,
      os_uptime_secs: 635064,
      booted_at: '2026-09-15T09:31:11Z',
      awake_hold: true,
      hold_error: null,
      power_requests: 'SYSTEM: …',
      update_available: null,
      restart_pending: false,
      last_update_check: '2026-09-22T17:54:45Z',
      last_update_result: 'up to date',
      updated_from: '0.2.0',
      updated_at: '2026-09-22T17:54:07Z',
    })
    expect(s.hostname).toBe('SANTI-PC')
    expect(s.osUptimeSecs).toBe(635064)
    expect(s.awakeHold).toBe(true)
  })

  it('reads a 0.2.0 document, which lacks the machine uptime', () => {
    const s = agentStatus({ version: '0.2.0', hostname: 'X', awake_hold: true })
    expect(s.osUptimeSecs).toBeNull()
    expect(s.bootedAt).toBeNull()
    expect(s.lastUpdateResult).toBeNull()
  })

  it('refuses a body without a version', () => {
    expect(() => agentStatus({ hostname: 'X' })).toThrow()
  })
})

describe('agentStatus, 0.4.0', () => {
  it('reads the policy and the Claude report', () => {
    const s = agentStatus({
      version: '0.4.0',
      hostname: 'SANTI-PC',
      awake_hold: false,
      policy: { awake_hold: false, claude_remote_control: true },
      tray: { reporting: true, last_report: '2026-09-22T20:00:00Z' },
      claude: {
        path: 'C:\\Users\\santi\\.local\\bin\\claude.exe',
        cli_version: '2.1.276',
        state: 'running',
        pid: 1234,
        started_at: '2026-09-22T19:00:00Z',
        restarts: 1,
        server: {
          version: '2.1.276',
          environment_id: 'env_1',
          spawn_mode: 'same-dir',
          max_sessions: 4,
        },
        sessions: [{ pid: 9, name: 'santi-ab', alive: true, started_at: 1790000000000 }],
        credentials: { present: true, subscription_type: 'max', refresh_expires_at: 1790500000000 },
        settings: { model: 'opus' },
        reported_at: '2026-09-22T20:00:00Z',
      },
    })
    expect(s.policy.awakeHold).toBe(false)
    expect(s.trayReporting).toBe(true)
    expect(s.claude?.server.environmentId).toBe('env_1')
    expect(s.claude?.sessions[0]?.name).toBe('santi-ab')
    expect(s.claude?.credentials.subscriptionType).toBe('max')
  })

  it('gives an older agent the held-awake, no-Claude defaults', () => {
    const s = agentStatus({ version: '0.3.0', awake_hold: true })
    expect(s.policy).toEqual({ awakeHold: true, claudeRemoteControl: false })
    expect(s.claude).toBeNull()
    expect(s.trayReporting).toBe(false)
  })
})

describe('agentHasClaude', () => {
  it('starts at 0.4.0', async () => {
    const { agentHasClaude } = await import('./status')
    expect(agentHasClaude('0.3.0')).toBe(false)
    expect(agentHasClaude('0.4.0')).toBe(true)
    expect(agentHasClaude('1.0.0')).toBe(true)
    expect(agentHasClaude('')).toBe(false)
  })
})
