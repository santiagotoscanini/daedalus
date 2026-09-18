import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// What the token store must never do.
//
// Two properties, and both are invisible from the outside when they break: the
// stored value must not BE the token, and a revoked token must not still open
// the door. The database is faked down to the three chains this module builds —
// a real one would be testing drizzle, not this.
//
// drizzle's `eq(...)` is an opaque SQL object the fake cannot read a value out
// of, so the two selectors a test needs to steer — which digest a select finds,
// which row an update hits — are set on the fixture just before the call. That
// is a seam in the fake, not in the module: what is asserted below is always
// what tokens.ts WROTE or ANSWERED, never how the fake decided.

type Row = {
  id: string
  label: string
  scope: 'read' | 'write'
  tokenHash: string
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}

const h = vi.hoisted(() => ({
  rows: [] as Row[],
  /** Exactly what was handed to `.values()`, so a test can look for a leak in it. */
  inserted: [] as Record<string, unknown>[],
  /** The digest the next `select ... where` should match, or null for "any". */
  selecting: null as string | null,
  /** The row id the next `update ... where` should hit. */
  revoking: null as string | null,
}))

vi.mock('../db', () => ({
  db: {
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        returning: async () => {
          h.inserted.push(v)
          const row: Row = {
            id: `tok-${String(h.rows.length + 1)}`,
            label: String(v.label),
            scope: v.scope as 'read' | 'write',
            tokenHash: String(v.tokenHash),
            createdAt: new Date('2026-09-18T00:00:00Z'),
            lastUsedAt: null,
            revokedAt: null,
          }
          h.rows.push(row)
          return [row]
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            h.rows.filter((r) => h.selecting === null || r.tokenHash === h.selecting),
          orderBy: async () => [...h.rows],
        }),
        orderBy: async () => [...h.rows],
      }),
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            const row = h.rows.find((r) => r.id === h.revoking)
            if (row === undefined) return []
            Object.assign(row, s)
            return [{ id: row.id }]
          },
        }),
      }),
    }),
  },
}))

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

beforeEach(() => {
  h.rows = []
  h.inserted = []
  h.selecting = null
  h.revoking = null
})

describe('minting', () => {
  it('stores a digest and never the token', async () => {
    const { mintMcpToken, MCP_TOKEN_PREFIX } = await import('./tokens')
    const { token, row } = await mintMcpToken({ label: 'claude-code', scope: 'write' })

    expect(token.startsWith(MCP_TOKEN_PREFIX)).toBe(true)
    // 32 bytes as base64url is 43 characters — enough entropy that a plain
    // SHA-256 is the right stored form, because there is no dictionary to slow.
    expect(token.length).toBeGreaterThan(MCP_TOKEN_PREFIX.length + 40)

    const written = h.inserted[0] ?? {}
    expect(written.tokenHash).toBe(sha(token))
    // The assertion that matters: the value appears nowhere in what was stored,
    // and nowhere in the row the UI will render.
    expect(JSON.stringify(written)).not.toContain(token)
    expect(JSON.stringify(row)).not.toContain(token)
  })

  it('mints a different token every time', async () => {
    const { mintMcpToken } = await import('./tokens')
    const a = await mintMcpToken({ label: 'a', scope: 'read' })
    const b = await mintMcpToken({ label: 'b', scope: 'read' })
    expect(a.token).not.toBe(b.token)
  })

  it('refuses a blank label, because the label is what its writes are signed with', async () => {
    const { mintMcpToken } = await import('./tokens')
    await expect(mintMcpToken({ label: '   ', scope: 'write' })).rejects.toThrow(/label/)
    expect(h.inserted).toEqual([])
  })
})

describe('identifying', () => {
  it('answers null for an absent or blank presentation', async () => {
    const { identifyMcpToken } = await import('./tokens')
    expect(await identifyMcpToken(null)).toBeNull()
    expect(await identifyMcpToken('')).toBeNull()
    expect(await identifyMcpToken('   ')).toBeNull()
  })

  it('answers the identity for a live token', async () => {
    const { mintMcpToken, identifyMcpToken } = await import('./tokens')
    const { token } = await mintMcpToken({ label: 'triage', scope: 'read' })
    h.selecting = sha(token)
    expect(await identifyMcpToken(token)).toEqual({ id: 'tok-1', label: 'triage', scope: 'read' })
  })

  it('answers null once the token is revoked', async () => {
    const { mintMcpToken, identifyMcpToken, revokeMcpToken } = await import('./tokens')
    const { token, row } = await mintMcpToken({ label: 'triage', scope: 'write' })
    h.revoking = row.id
    expect(await revokeMcpToken(row.id)).toBe(true)

    h.selecting = sha(token)
    // The same answer an unknown token gets. Revocation is immediate, and it is
    // silent: a caller must not learn that the token it holds once existed.
    expect(await identifyMcpToken(token)).toBeNull()
  })

  it('answers null for a presentation whose digest matches no row', async () => {
    const { mintMcpToken, identifyMcpToken } = await import('./tokens')
    await mintMcpToken({ label: 'triage', scope: 'read' })
    h.selecting = sha('dmcp_not-a-real-token')
    expect(await identifyMcpToken('dmcp_not-a-real-token')).toBeNull()
  })
})
