import { describe, expect, it } from 'vitest'
import type { RelayDelivery } from '../../../lib/dashboard/mail-relay'
import { localDay } from '../../../lib/format'
import { relayStats } from './relay'

const now = Date.parse('2026-10-30T12:00:00Z')
const DAY = 86_400_000

const send = (unit: string, at: number, ok = true): RelayDelivery => ({
  at,
  unit,
  about: /^notify-email@(.+)\.service$/.exec(unit)?.[1] ?? null,
  recipients: ['alice@example.org'],
  bytes: 500,
  smtpStatus: ok ? 250 : null,
  smtpMessage: ok ? '250 OK' : null,
  exitCode: ok ? 'EX_OK' : 'EX_TEMPFAIL',
  ok,
  error: ok ? null : 'timeout',
})

describe('relayStats', () => {
  const deliveries = [
    send('notify-email@backup.service', now - 1_000),
    send('notify-email@backup.service', now - 2 * DAY, false),
    send('smartd.service', now - 2 * DAY),
    send('notify-email@backup.service', now - 3 * DAY),
    // Outside the window: counted for its caller, on no day.
    send('old.service', now - 40 * DAY),
  ]

  it('buckets thirty local days, oldest first, sent and failed apart', () => {
    const { days } = relayStats(deliveries, now)
    expect(days).toHaveLength(30)
    expect(days[29]).toEqual({ day: localDay(now), sent: 1, failed: 0 })
    expect(days[27]).toEqual({ day: localDay(now - 2 * DAY), sent: 1, failed: 1 })
    expect(days.reduce((n, d) => n + d.sent + d.failed, 0)).toBe(4)
  })

  it('ranks the callers by how much they sent, and keeps what a notice was about', () => {
    const { callers } = relayStats(deliveries, now)
    expect(callers.map((c) => [c.unit, c.about, c.sent, c.failed])).toEqual([
      ['notify-email@backup.service', 'backup', 2, 1],
      ['smartd.service', null, 1, 0],
      ['old.service', null, 1, 0],
    ])
    expect(callers[0]?.lastAt).toBe(now - 1_000)
  })
})
