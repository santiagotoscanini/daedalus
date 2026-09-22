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
