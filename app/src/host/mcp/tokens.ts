import { createHash, randomBytes } from 'node:crypto'
import { desc, eq, isNull } from 'drizzle-orm'
import { type McpScope, scopeReaches } from '../../lib/mcp'
import { db } from '../db'
import { safeEqual } from '../github-app-crypto'
import { mcpTokens } from '../schema'

// Minting, verifying and revoking the credentials that reach /mcp.
//
// The whole security of the MCP door is here, so the file is deliberately
// small enough to read in one sitting.
//
// THE SHAPE. `dmcp_` plus 32 bytes of `randomBytes`, base64url. The prefix
// exists for one reason: a secret scanner, a log redactor and a person reading
// a paste can all recognise it. 32 bytes is 256 bits of entropy, which is why
// the stored form can be a plain SHA-256 rather than a password hash — there
// is no dictionary attack on a value nobody chose.
//
// THE COMPARISON. The presented token is hashed and the row is selected on
// that hash, which is already timing-safe in the sense that matters (the
// database is compared against a digest, and a digest of a wrong guess is
// uncorrelated with the right one). `safeEqual` then confirms the row it found
// really is the one, in constant time, for the same reason /api/deploy does:
// these credentials stand in front of a path that starts privileged units, and
// the cheap habit is the one worth keeping.
//
// FAIL CLOSED, everywhere. No token minted means every call is refused; a
// revoked token is refused; an unknown one is refused. There is no
// "unconfigured means open" state, which is the mistake `/api/deploy`'s 503
// exists to avoid and the one this file must not reintroduce.

/** How a token announces itself, so a scanner and a person both recognise one. */
export const MCP_TOKEN_PREFIX = 'dmcp_'

const BYTES = 32

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

/** A token row as the UI lists it — never the token, which no longer exists. */
export type McpTokenRow = {
  id: string
  label: string
  scope: McpScope
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

/** What a caller proved by presenting a token. */
export type McpIdentity = {
  id: string
  /** The token's label. This becomes the ACTOR of everything it writes. */
  label: string
  scope: McpScope
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString())

/**
 * Mint a token.
 *
 * The only moment the value exists. It is returned once, stored as a digest,
 * and cannot be recovered — the caller shows it to the operator and forgets it.
 */
export async function mintMcpToken(input: {
  label: string
  scope: McpScope
}): Promise<{ row: McpTokenRow; token: string }> {
  const label = input.label.trim()
  if (label === '') throw new Error('a token needs a label — it is what its writes are signed with')
  if (label.length > 64) throw new Error('a label is at most 64 characters')

  const token = MCP_TOKEN_PREFIX + randomBytes(BYTES).toString('base64url')
  const [row] = await db
    .insert(mcpTokens)
    .values({ label, scope: input.scope, tokenHash: hash(token) })
    .returning()
  if (row === undefined) throw new Error('the token was not stored')

  return {
    row: {
      id: row.id,
      label: row.label,
      scope: row.scope,
      createdAt: row.createdAt.toISOString(),
      lastUsedAt: iso(row.lastUsedAt),
      revokedAt: iso(row.revokedAt),
    },
    token,
  }
}

/** Every token ever minted, newest first. Revoked ones stay, so their labels still explain old records. */
export async function listMcpTokens(): Promise<McpTokenRow[]> {
  const rows = await db.select().from(mcpTokens).orderBy(desc(mcpTokens.createdAt))
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    scope: r.scope,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: iso(r.lastUsedAt),
    revokedAt: iso(r.revokedAt),
  }))
}

/** Revoke a token. Idempotent: a second call keeps the first revocation's time. */
export async function revokeMcpToken(id: string): Promise<boolean> {
  const updated = await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(eq(mcpTokens.id, id))
    .returning({ id: mcpTokens.id })
  return updated.length > 0
}

/** Whether any usable token exists at all — what the panel says when there are none. */
export async function anyLiveMcpToken(): Promise<boolean> {
  const rows = await db
    .select({ id: mcpTokens.id })
    .from(mcpTokens)
    .where(isNull(mcpTokens.revokedAt))
    .limit(1)
  return rows.length > 0
}

/**
 * The identity behind a presented token, or null.
 *
 * Null for every failure without distinguishing them — unknown, revoked,
 * malformed and absent all answer the same thing, because telling a caller
 * WHICH of those it is tells an attacker whether a guess existed.
 *
 * `lastUsedAt` is written on the way through. Deliberately not awaited by the
 * caller's critical path below — see the note there.
 */
export async function identifyMcpToken(presented: string | null): Promise<McpIdentity | null> {
  const token = presented?.trim() ?? ''
  if (token === '') return null

  const digest = hash(token)
  const [row] = await db.select().from(mcpTokens).where(eq(mcpTokens.tokenHash, digest)).limit(1)
  if (row === undefined) return null
  // Belt and braces, and the same habit as /api/deploy: the row was found by
  // digest, and this confirms it in constant time rather than by `===`.
  if (!safeEqual(row.tokenHash, digest)) return null
  if (row.revokedAt !== null) return null

  return { id: row.id, label: row.label, scope: row.scope }
}

/** Record that a token was used. Best-effort: a failed stamp must never fail a call. */
export async function stampMcpTokenUse(id: string): Promise<void> {
  try {
    await db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, id))
  } catch (err) {
    console.warn('[mcp] could not stamp token use:', err instanceof Error ? err.message : err)
  }
}

/** Whether this identity reaches a tool of that scope. */
export function identityReaches(identity: McpIdentity, needed: McpScope): boolean {
  return scopeReaches(identity.scope, needed)
}
