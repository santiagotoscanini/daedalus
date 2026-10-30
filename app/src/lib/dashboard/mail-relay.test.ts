import { describe, expect, it } from 'vitest'
import type { LokiStream } from '../../host/loki'
import { relayDeliveries } from './mail-relay'

// What the relay's own log lines say. msmtp writes one line per attempt,
// filed under the unit that was sending; these are that line's two shapes.

const now = Date.parse('2026-10-30T12:00:00Z')
/** A Loki timestamp (ns since the epoch) `minutes` before `now`. */
const ns = (minutes: number) => String((now - minutes * 60_000) * 1e6)

const OK = (to: string) =>
  `host=smtp.example.org tls=on auth=on user=box@example.org from=box@example.org recipients=${to} mailsize=812 smtpstatus=250 smtpmsg='250 2.0.0 OK' exitcode=EX_OK`
const FAIL = (why: string) =>
  `host=smtp.example.org tls=on auth=on user=box@example.org from=box@example.org recipients=alice@example.org errormsg='${why}' exitcode=EX_NOPERM`

const stream = (unit: string, values: [string, string][]): LokiStream => ({
  stream: { unit },
  values,
})

describe('relayDeliveries', () => {
  it('reads an unreachable Loki as unknown, never as a quiet month', () => {
    expect(relayDeliveries(null, now)).toEqual({
      lastSend: null,
      sent30d: null,
      failed30d: null,
      failures: [],
      failing: false,
    })
  })

  it('reads no lines as nothing sent and nothing failed', () => {
    expect(relayDeliveries([], now)).toMatchObject({
      lastSend: null,
      sent30d: 0,
      failed30d: 0,
      failing: false,
    })
  })

  it('counts both kinds across units and names the newest success', () => {
    const r = relayDeliveries(
      [
        stream('smartd.service', [[ns(600), OK('alice@example.org')]]),
        stream('notify-email@backup.service', [
          [ns(60), OK('alice@example.org')],
          [ns(1440), FAIL('authentication failed (method PLAIN)')],
        ]),
      ],
      now,
    )
    expect(r.sent30d).toBe(2)
    expect(r.failed30d).toBe(1)
    expect(r.lastSend).toEqual({
      agoSeconds: 3600,
      unit: 'notify-email@backup.service',
      recipients: 'alice@example.org',
    })
    expect(r.failures).toEqual([
      {
        agoSeconds: 86_400,
        unit: 'notify-email@backup.service',
        error: 'authentication failed (method PLAIN)',
      },
    ])
    // Recovered since: history, not a current failure.
    expect(r.failing).toBe(false)
  })

  it('calls a failure newer than every success a current one', () => {
    const r = relayDeliveries(
      [
        stream('smartd.service', [
          [ns(5), FAIL('cannot connect to smtp.example.org')],
          [ns(90), OK('alice@example.org')],
        ]),
      ],
      now,
    )
    expect(r.failing).toBe(true)
    expect(r.failures[0]?.error).toBe('cannot connect to smtp.example.org')
  })

  it('calls failures with no success at all current too', () => {
    const r = relayDeliveries([stream('x.service', [[ns(5), FAIL('timeout')]])], now)
    expect(r).toMatchObject({ failing: true, lastSend: null, sent30d: 0, failed30d: 1 })
  })

  it('keeps the whole line when a failure carries no errormsg', () => {
    const line = 'host=smtp.example.org tls=on exitcode=EX_TEMPFAIL'
    const r = relayDeliveries([stream('x.service', [[ns(1), line]])], now)
    expect(r.failures[0]?.error).toBe(line)
  })
})
