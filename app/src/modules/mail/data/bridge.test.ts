import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSnapshot } from '../../../host/contract/snapshot'
import { REPORTING_MS, readBridge, reportOf } from './bridge'

// The status file Proton Mail Bridge's supervisor writes, read the way the
// Email page reads it: through the snapshot reader, from a real file.

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bridge-'))
  path = join(dir, 'status.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** What the page is handed instead of a Ctx: the path's row, and the real reader. */
const ctx = (bound: string | undefined = path) => ({
  env: () => bound,
  snapshot: readSnapshot,
})

const iso = (ms: number) => new Date(ms).toISOString()

/** A v1 document as the supervisor marshals it, written `ageMs` ago. */
function doc(ageMs = 5_000, over: Record<string, unknown> = {}) {
  const now = Date.now()
  return {
    schemaVersion: 1,
    phase: 'running',
    startedAt: iso(now - 3_600_000),
    updatedAt: iso(now - ageMs),
    version: '3.27.1',
    online: true,
    imap: { port: 1143, ssl: true },
    smtp: { port: 1025, ssl: true },
    users: [
      {
        id: 'u1',
        username: 'someone',
        state: 'connected',
        splitMode: false,
        addresses: ['someone@example.org', 'alias@example.org'],
        usedBytes: 123_456_789,
        totalBytes: 16_106_127_360,
        sync: {
          state: 'syncing',
          progress: 0.42,
          elapsedMs: 61_000,
          remainingMs: 1_897_000,
          startedAt: iso(now - 61_000),
          finishedAt: null,
        },
      },
    ],
    events: [
      { at: iso(now - 61_000), kind: 'sync-started' },
      { at: iso(now - 120_000), kind: 'imap-login-failed', detail: 'someone' },
    ],
    ...over,
  }
}

const write = (v: unknown) => writeFile(path, JSON.stringify(v, null, 2))

describe('the Bridge status file', () => {
  it('reads a fresh v1 document whole', async () => {
    await write(doc())
    const r = await readBridge(ctx())
    expect(r.reporting).toBe(true)
    expect(r.error).toBeNull()
    expect(r.status?.version).toBe('3.27.1')
    expect(r.status?.imap).toEqual({ port: 1143, ssl: true })
    const [u] = r.status?.users ?? []
    expect(u?.state).toBe('connected')
    expect(u?.addresses).toEqual(['someone@example.org', 'alias@example.org'])
    expect(u?.sync).toMatchObject({ state: 'syncing', progress: 0.42, remainingMs: 1_897_000 })
    // `detail` is omitted when empty, and reads as ''.
    expect(r.status?.events.map((e) => [e.kind, e.detail])).toEqual([
      ['sync-started', ''],
      ['imap-login-failed', 'someone'],
    ])
  })

  it('takes the nulls Go writes for an empty slice and an unreported connection', async () => {
    const d = doc()
    await write({
      ...d,
      phase: 'starting',
      online: null,
      users: [{ ...d.users[0], addresses: null }],
      events: null,
    })
    const r = await readBridge(ctx())
    expect(r.reporting).toBe(true)
    expect(r.status?.online).toBeNull()
    expect(r.status?.users[0]?.addresses).toEqual([])
    expect(r.status?.events).toEqual([])
  })

  it('refuses another schema version, saying which', async () => {
    await write(doc(5_000, { schemaVersion: 2 }))
    const r = await readBridge(ctx())
    expect(r).toMatchObject({ status: null, reporting: false })
    expect(r.error).toMatch(/schemaVersion: expected schema version 1, got 2/)
  })

  it('refuses an account state it does not know', async () => {
    const d = doc()
    await write({ ...d, users: [{ ...d.users[0], state: 'paused' }] })
    const r = await readBridge(ctx())
    expect(r).toMatchObject({ status: null, reporting: false })
    expect(r.error).toMatch(/users\[0\]\.state/)
  })

  it('keeps a stale document but says it is not reporting', async () => {
    await write(doc(REPORTING_MS + 60_000))
    const r = await readBridge(ctx())
    expect(r.reporting).toBe(false)
    expect(r.error).toBeNull()
    // The last word stays readable (its events, when it was), never as current.
    expect(r.status?.users).toHaveLength(1)
  })

  it('reads a missing file as not reporting, with no error', async () => {
    expect(await readBridge(ctx())).toEqual({ status: null, reporting: false, error: null })
  })

  it('reads an unbound path the same way, without touching the disk', async () => {
    expect(await readBridge(ctx(undefined))).toEqual({
      status: null,
      reporting: false,
      error: null,
    })
  })
})

describe('reportOf', () => {
  const now = Date.parse('2026-10-30T12:00:00Z')
  const read = (updatedAt: string) =>
    reportOf(
      {
        // Only `updatedAt` is consulted; the rest is the shape.
        data: { ...doc(), updatedAt } as never,
        available: true,
        generatedAt: null,
        ageMs: null,
        stale: false,
        error: null,
      },
      now,
    )

  it('draws the line at REPORTING_MS, by the document’s own clock', () => {
    expect(read(iso(now - REPORTING_MS)).reporting).toBe(true)
    expect(read(iso(now - REPORTING_MS - 1)).reporting).toBe(false)
  })

  it('does not trust an updatedAt it cannot parse', () => {
    expect(read('yesterday').reporting).toBe(false)
  })
})
