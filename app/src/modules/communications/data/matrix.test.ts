import { describe, expect, it } from 'vitest'
import { decode } from '../../../lib/contract/decode'
import { matrixStatus, reportOf } from './matrix'

// The status file stacks/matrix's helper writes (schema 1), decoded the way
// the Communications page decodes it. Values are made up.

const bridge = (state: string | null) => ({
  ready: true,
  bot: '@bot:example.org',
  commandPrefix: '!x',
  logins: state === null ? null : [{ id: 'l1', name: 'Someone', state, since: 1_793_813_850 }],
})

const base = {
  schema: 1,
  generatedAt: '2026-11-04T17:40:00Z',
  homeserver: { serverName: 'example.org', healthy: true, version: '1.164.2' },
  operator: { mxid: '@op:example.org', signedIn: true, joinedRooms: 12 },
  reader: { mxid: '@reader:example.org', signedIn: true, pending: 0 },
  whatsapp: bridge('CONNECTED'),
}

describe('matrixStatus', () => {
  it('reads a LinkedIn bridge beside WhatsApp', () => {
    const s = decode(matrixStatus, { ...base, linkedin: bridge('CONNECTED') })
    expect(s.whatsapp.logins[0]?.state).toBe('CONNECTED')
    expect(s.linkedin?.logins[0]?.name).toBe('Someone')
    expect(s.linkedin?.commandPrefix).toBe('!x')
  })

  it('reads a helper that carries no LinkedIn bridge as none', () => {
    expect(decode(matrixStatus, base).linkedin).toBeNull()
  })

  it('reads a bridge with no logins (Go writes null) as an empty list', () => {
    const s = decode(matrixStatus, { ...base, linkedin: bridge(null) })
    expect(s.linkedin?.logins).toEqual([])
  })

  it('refuses another schema', () => {
    expect(() => decode(matrixStatus, { ...base, schema: 2 })).toThrow()
  })
})

describe('reportOf', () => {
  it('is not reporting once the file is older than four heartbeats', () => {
    const status = decode(matrixStatus, base)
    const at = Date.parse(base.generatedAt)
    const r = (now: number) =>
      reportOf(
        {
          available: true,
          data: status,
          error: null,
          generatedAt: null,
          ageMs: null,
          stale: false,
        },
        now,
      )
    expect(r(at + 60_000).reporting).toBe(true)
    expect(r(at + 3 * 60_000).reporting).toBe(false)
  })
})
