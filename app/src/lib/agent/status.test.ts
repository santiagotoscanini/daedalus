import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DecodeError, decode } from '../contract/decode'
import { report, statusDocument, telemetry } from './status'

// The machine's documents, decoded strictly: the agent's own fixtures
// (host/controller/generated/fixtures/, written by its gate) read whole, and
// one with a field missing does not read as a fallback.

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`../../host/controller/generated/fixtures/${name}.json`, import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>

describe('a machine’s documents', () => {
  const detail = fixture('nodes.get')

  it('reads the status document, the open telemetry and the report the agent writes', () => {
    const s = decode(statusDocument, detail.status)
    expect(s.hostname).toBe('PC')
    expect(s.controller?.state).toBe('approved')
    expect(s.claude?.state).toBe('running')
    expect(decode(telemetry, detail.telemetry).sampled_at).toBe('2026-09-27T10:00:15Z')
    const r = decode(report, fixture('nodes.claude').report)
    expect(r.sessions[0]?.alive).toBe(true)
    expect(r.last_line).toBeUndefined()
  })

  it('refuses a document missing a field the agent always writes', () => {
    const { tray: _, ...status } = detail.status as Record<string, unknown>
    expect(() => decode(statusDocument, status)).toThrow(DecodeError)
    expect(() =>
      decode(statusDocument, { ...(detail.status as object), controller: { state: 'x' } }),
    ).toThrow(DecodeError)
  })
})
