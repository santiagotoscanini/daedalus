import { describe, expect, it } from 'vitest'
import type { LokiStream } from '../../../host/loki'
import { grafanaFailures, healthchecksMail } from './senders'

const now = Date.parse('2026-10-30T12:00:00Z')
const ns = (minutes: number) => String((now - minutes * 60_000) * 1e6)
const stream = (values: [string, string][]): LokiStream => ({ stream: {}, values })

describe('healthchecksMail', () => {
  it('counts each delivery line by its outcome', () => {
    expect(
      healthchecksMail([
        stream([
          [ns(1), '  4b03fad7 (email) OK in 2.2s'],
          [ns(2), '  4b03fad7 (email) OK in 3.1s'],
          [ns(3), '  4b03fad7 (email) Error in 10.0s: timed out'],
        ]),
      ]),
    ).toEqual({ sent: 2, failed: 1 })
  })
})

describe('grafanaFailures', () => {
  it('keeps the err field of each failure, newest first', () => {
    const line = (why: string) =>
      `logger=ngalert.notifier level=error msg="Notify for alerts failed" num_alerts=1 err="email/email[0]: ${why}" aggrGroup="{}"`
    const f = grafanaFailures([
      stream([
        [ns(60), line('failed to send email: dial tcp: i/o timeout')],
        [ns(5), line('lookup smtp.example.org: no such host')],
      ]),
    ])
    expect(f).toEqual([
      { at: now - 5 * 60_000, error: 'email/email[0]: lookup smtp.example.org: no such host' },
      {
        at: now - 60 * 60_000,
        error: 'email/email[0]: failed to send email: dial tcp: i/o timeout',
      },
    ])
  })
})
