import { desc, eq } from 'drizzle-orm'
import { db } from '../../host/db'
import { mcpTokens } from '../../host/schema'
import type { McpScope } from '../mcp'

// The rows behind the MCP door's credentials. What a token IS — its shape, its
// digest, when one is refused — is host/mcp/tokens.ts; this file only stores
// and finds digests.

export type McpTokenRecord = typeof mcpTokens.$inferSelect

export async function insertMcpToken(v: {
  label: string
  scope: McpScope
  tokenHash: string
}): Promise<McpTokenRecord | undefined> {
  const [row] = await db.insert(mcpTokens).values(v).returning()
  return row
}

/** Newest first. */
export async function listMcpTokenRows(): Promise<McpTokenRecord[]> {
  return db.select().from(mcpTokens).orderBy(desc(mcpTokens.createdAt))
}

export async function findMcpTokenByHash(tokenHash: string): Promise<McpTokenRecord | undefined> {
  const [row] = await db.select().from(mcpTokens).where(eq(mcpTokens.tokenHash, tokenHash)).limit(1)
  return row
}

/** True when the id named a row. */
export async function setMcpTokenRevoked(id: string): Promise<boolean> {
  const updated = await db
    .update(mcpTokens)
    .set({ revokedAt: new Date() })
    .where(eq(mcpTokens.id, id))
    .returning({ id: mcpTokens.id })
  return updated.length > 0
}

export async function setMcpTokenUsed(id: string): Promise<void> {
  await db.update(mcpTokens).set({ lastUsedAt: new Date() }).where(eq(mcpTokens.id, id))
}
