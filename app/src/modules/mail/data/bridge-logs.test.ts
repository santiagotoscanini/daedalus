import { describe, expect, it } from 'vitest'
import type { LokiStream } from '../../../host/loki'
import { bridgeLogs, parseBridgeLine, verdictOf } from './bridge-logs'

// Bridge's logrus lines as they reach Loki: colour codes and all.

const now = Date.parse('2026-10-30T12:00:00Z')
const ns = (minutes: number) => String((now - minutes * 60_000) * 1e6)
const C = (code: number, s: string) => `\u001b[${String(code)}m${s}\u001b[0m`

const KEYCHAIN = `${C(33, 'WARN')}[Oct 30 10:44:53.336] Failed to add test credentials to keychain    ${C(33, 'error')}="failed to open dbus connection: exec: \\"dbus-launch\\": executable file not found in $PATH" ${C(33, 'helper')}="*keychain.SecretServiceDBusHelper"`
const TOKEN_WARN = `${C(33, 'WARN')}[Oct 30 11:02:10.001] Received error response from API              ${C(33, 'status')}=401 ${C(33, 'error')}="Invalid access token"`
const TOKEN_ERRO = `${C(31, 'ERRO')}[Oct 30 11:02:10.002] Request failed                                ${C(31, 'status')}=401 ${C(31, 'error')}="401 Unauthorized: Invalid access token"`
const REVOKED = `${C(31, 'ERRO')}[Oct 30 11:40:00.000] Auth refresh failed                           ${C(31, 'error')}="failed to refresh auth: 422"`

const stream = (values: [string, string][]): LokiStream => ({
  stream: { stack: 'proton-bridge' },
  values,
})

describe('parseBridgeLine', () => {
  it('reads level, message and fields through the colour codes', () => {
    expect(parseBridgeLine(KEYCHAIN)).toEqual({
      level: 'warn',
      message: 'Failed to add test credentials to keychain',
      fields: {
        error:
          'failed to open dbus connection: exec: "dbus-launch": executable file not found in $PATH',
        helper: '*keychain.SecretServiceDBusHelper',
      },
    })
  })

  it('reads a line with no fields, and refuses one that is not a warning or worse', () => {
    expect(parseBridgeLine('ERRO[Oct 30 10:00:00.000] Something broke')).toEqual({
      level: 'error',
      message: 'Something broke',
      fields: {},
    })
    expect(parseBridgeLine('gpg: checking the trustdb')).toBeNull()
    expect(parseBridgeLine(`${C(36, 'INFO')}[Oct 30 10:00:00.000] Started`)).toBeNull()
  })
})

describe('verdictOf', () => {
  it('calls the expired-token 401 routine, in both its forms', () => {
    for (const l of [TOKEN_WARN, TOKEN_ERRO]) {
      const line = parseBridgeLine(l)
      expect(line && verdictOf(line)).toBe('routine')
    }
  })

  it('calls a failed refresh a sign-in, and anything else nothing', () => {
    const revoked = parseBridgeLine(REVOKED)
    const keychain = parseBridgeLine(KEYCHAIN)
    expect(revoked && verdictOf(revoked)).toBe('sign-in')
    expect(keychain && verdictOf(keychain)).toBeNull()
  })
})

describe('bridgeLogs', () => {
  it('counts the routine lines apart and groups repeats, newest first', () => {
    const r = bridgeLogs([
      stream([
        [ns(5), KEYCHAIN],
        [ns(20), REVOKED],
        [ns(58), TOKEN_ERRO],
        [ns(58), TOKEN_WARN],
        [ns(90), KEYCHAIN],
        [ns(91), 'gpg: checking the trustdb'],
      ]),
    ])
    expect(r).toMatchObject({ warnings: 2, errors: 1, routine: 2, capped: false })
    expect(r.groups.map((g) => [g.level, g.message, g.count, g.verdict])).toEqual([
      ['warn', 'Failed to add test credentials to keychain', 2, null],
      ['error', 'Auth refresh failed', 1, 'sign-in'],
      ['error', 'Request failed', 1, 'routine'],
      ['warn', 'Received error response from API', 1, 'routine'],
    ])
    expect(r.groups[0]?.lastAt).toBe(now - 5 * 60_000)
    expect(r.groups[1]?.detail).toBe('failed to refresh auth: 422')
  })

  it('reads no lines as a quiet day', () => {
    expect(bridgeLogs([])).toEqual({
      windowHours: 24,
      warnings: 0,
      errors: 0,
      routine: 0,
      groups: [],
      capped: false,
    })
  })
})
