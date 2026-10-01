import { and, desc, eq, gte, lt } from 'drizzle-orm'
import { db } from '../../host/db'
import { deployments } from '../../host/schema'

// The deployments table: deploy.sh's journal as lib/apps/deployments.ts
// folds it in, and the history the pages read back.

/**
 * The one spelling a digest is stored in: `sha256:<hex>`. Applied on every
 * write and to every digest a lookup is given, so a match is one equality.
 */
export const sha256Digest = (d: string): string => (d.startsWith('sha256:') ? d : `sha256:${d}`)

/** `digest@startedAt` of the app's rows from `since` on — what an ingest checks a journal against. */
export async function deploymentKeysSince(appId: string, since: Date): Promise<Set<string>> {
  const rows = await db
    .select({ digest: deployments.digest, startedAt: deployments.startedAt })
    .from(deployments)
    .where(and(eq(deployments.appId, appId), gte(deployments.startedAt, since)))
  return new Set(rows.map((r) => deploymentKey(r.digest, r.startedAt)))
}

export const deploymentKey = (digest: string, startedAt: Date): string =>
  `${sha256Digest(digest)}@${startedAt.toISOString()}`

/**
 * Insert journal entries. The unique index on (app, digest, startedAt) makes
 * a line already stored a no-op.
 */
export async function insertDeployments(rows: (typeof deployments.$inferInsert)[]): Promise<void> {
  if (rows.length === 0) return
  await db
    .insert(deployments)
    .values(
      rows.map((r) => ({
        ...r,
        digest: sha256Digest(r.digest),
        previousDigest: r.previousDigest ? sha256Digest(r.previousDigest) : null,
      })),
    )
    .onConflictDoNothing()
}

export async function listDeployments(appId: string, limit = 25) {
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.appId, appId))
    .orderBy(desc(deployments.startedAt))
    .limit(limit)
}

/** Retention: delete deploys that started before `olderThan`. Returns how many went. */
export async function pruneDeployments(olderThan: Date): Promise<number> {
  const rows = await db
    .delete(deployments)
    .where(lt(deployments.startedAt, olderThan))
    .returning({ id: deployments.id })
  return rows.length
}
