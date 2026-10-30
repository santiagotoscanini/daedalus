import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSnapshot } from '../../../host/contract/snapshot'
import { REPORTING_MS, readBridge, reportOf } from './bridge'

// The status file Proton Mail Bridge's supervisor writes (schema v2), read
// the way the Email page reads it: through the snapshot reader, from a real
// file.

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

/** A populated mailbox, as the supervisor's IMAP read writes it. */
function mailbox(now: number) {
  return {
    readAt: iso(now - 20_000),
    error: null,
    folders: [
      { name: 'Labels/work', kind: 'label', messages: 414, unseen: 0 },
      { name: 'INBOX', kind: 'system', messages: 9, unseen: 2 },
      { name: 'Folders/receipts', kind: 'folder', messages: 51, unseen: 0 },
      { name: 'All Mail', kind: 'system', messages: 19_615, unseen: 2 },
    ],
    days: Array.from({ length: 30 }, (_, i) => ({
      day: `2026-10-${String(i + 1).padStart(2, '0')}`,
      received: 10 + i,
      sent: i % 7 === 0 ? 1 : 0,
    })),
    windowCapped: false,
    topSenders: [{ address: 'news@example.org', name: 'Example News', count: 31 }],
    recent: [
      {
        date: iso(now - 600_000),
        fromName: 'Alice',
        fromAddress: 'alice@example.org',
        subject: 'Lunch',
        unread: true,
        flagged: false,
        attachments: true,
      },
    ],
  }
}

/** A v2 document as the supervisor marshals it, written `ageMs` ago. */
function doc(
  ageMs = 5_000,
  over: Record<string, unknown> = {},
  user: Record<string, unknown> = {},
) {
  const now = Date.now()
  return {
    schemaVersion: 2,
    phase: 'running',
    startedAt: iso(now - 3_600_000),
    updatedAt: iso(now - ageMs),
    version: '3.27.1',
    online: true,
    imap: { port: 1143, ssl: true },
    smtp: { port: 1025, ssl: true },
    settings: {
      keychain: 'pass-app',
      allMailVisible: true,
      alternativeRouting: false,
      telemetryDisabled: true,
      automaticUpdates: false,
      earlyAccess: false,
    },
    disk: { messageStoreBytes: 1_060_994_483, indexBytes: 46_145_536, measuredAt: iso(now) },
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
          lastDurationMs: 95_000,
        },
        mailbox: mailbox(now),
        ...user,
      },
    ],
    events: [
      { at: iso(now - 61_000), kind: 'sync-started' },
      { at: iso(now - 120_000), kind: 'mailbox-read-failed', detail: 'someone' },
    ],
    ...over,
  }
}

const write = (v: unknown) => writeFile(path, JSON.stringify(v, null, 2))

describe('the Bridge status file', () => {
  it('reads a fresh v2 document whole, mailbox and all', async () => {
    await write(doc())
    const r = await readBridge(ctx())
    expect(r.reporting).toBe(true)
    expect(r.error).toBeNull()
    expect(r.status?.version).toBe('3.27.1')
    expect(r.status?.settings).toEqual({
      keychain: 'pass-app',
      allMailVisible: true,
      alternativeRouting: false,
      telemetryDisabled: true,
      automaticUpdates: false,
      earlyAccess: false,
    })
    expect(r.status?.disk).toMatchObject({
      messageStoreBytes: 1_060_994_483,
      indexBytes: 46_145_536,
    })
    const [u] = r.status?.users ?? []
    expect(u?.sync).toMatchObject({ state: 'syncing', progress: 0.42, lastDurationMs: 95_000 })
    expect(u?.mailbox?.folders.map((f) => [f.name, f.kind, f.unseen])).toEqual([
      ['Labels/work', 'label', 0],
      ['INBOX', 'system', 2],
      ['Folders/receipts', 'folder', 0],
      ['All Mail', 'system', 2],
    ])
    expect(u?.mailbox?.days).toHaveLength(30)
    expect(u?.mailbox?.topSenders[0]).toEqual({
      address: 'news@example.org',
      name: 'Example News',
      count: 31,
    })
    expect(u?.mailbox?.recent[0]).toMatchObject({
      subject: 'Lunch',
      unread: true,
      attachments: true,
    })
    // `detail` is omitted when empty, and reads as ''; a kind added in v2 is kept.
    expect(r.status?.events.map((e) => [e.kind, e.detail])).toEqual([
      ['sync-started', ''],
      ['mailbox-read-failed', 'someone'],
    ])
  })

  it('reads an account not yet read over IMAP as no mailbox', async () => {
    await write(doc(5_000, {}, { mailbox: null }))
    const r = await readBridge(ctx())
    expect(r.reporting).toBe(true)
    expect(r.status?.users[0]?.mailbox).toBeNull()
  })

  it('keeps a failed read’s error beside the empty lists of an account never read well', async () => {
    const now = Date.now()
    await write(
      doc(
        5_000,
        {},
        {
          mailbox: {
            readAt: iso(now),
            error: 'imap: connection refused',
            folders: [],
            days: [],
            windowCapped: false,
            topSenders: null,
            recent: [],
          },
        },
      ),
    )
    const m = (await readBridge(ctx())).status?.users[0]?.mailbox
    expect(m?.error).toBe('imap: connection refused')
    expect(m?.folders).toEqual([])
    expect(m?.topSenders).toEqual([])
  })

  it('leaves out the settings Bridge did not answer for', async () => {
    await write(doc(5_000, { settings: { keychain: 'pass-app' }, disk: null }))
    const r = await readBridge(ctx())
    expect(r.status?.settings).toEqual({ keychain: 'pass-app' })
    expect(Object.keys(r.status?.settings ?? {})).toEqual(['keychain'])
    expect(r.status?.disk).toBeNull()
  })

  it('takes the nulls Go writes for an empty slice and an unreported connection', async () => {
    await write(doc(5_000, { phase: 'starting', online: null, events: null }, { addresses: null }))
    const r = await readBridge(ctx())
    expect(r.reporting).toBe(true)
    expect(r.status?.online).toBeNull()
    expect(r.status?.users[0]?.addresses).toEqual([])
    expect(r.status?.events).toEqual([])
  })

  it('refuses another schema version as not reporting, saying which', async () => {
    await write(doc(5_000, { schemaVersion: 1 }))
    const r = await readBridge(ctx())
    expect(r).toMatchObject({ status: null, reporting: false })
    expect(r.error).toMatch(/schemaVersion: expected schema version 2, got 1/)
  })

  it('refuses an account state it does not know', async () => {
    await write(doc(5_000, {}, { state: 'paused' }))
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
