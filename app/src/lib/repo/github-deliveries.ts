import { desc, eq, lt } from 'drizzle-orm'
import { db, type Executor } from '../db'
import { githubDeliveries } from '../schema'

// The webhook's replay guard. See the `github_deliveries` table comment.

export type DeliveryRecord = typeof githubDeliveries.$inferSelect

/**
 * Insert a delivery. True when the id is new; false when GitHub (or anybody
 * replaying a captured request) has sent it before.
 *
 * Takes the executor explicitly because it only guards anything inside the
 * same transaction as the enqueue: outside it, a crash between the two leaves
 * a recorded delivery that never built, and the redelivery that would recover
 * it is then refused as a duplicate.
 */
export async function recordDelivery(
  tx: Executor,
  delivery: { id: string; event: string; action?: string | null; outcome: string },
): Promise<boolean> {
  const rows = await tx
    .insert(githubDeliveries)
    .values({
      id: delivery.id,
      event: delivery.event,
      action: delivery.action ?? null,
      outcome: delivery.outcome,
    })
    .onConflictDoNothing({ target: githubDeliveries.id })
    .returning({ id: githubDeliveries.id })
  return rows.length > 0
}

/**
 * Replace a delivery's outcome. For an outcome known only after the insert
 * (the build a push queued); pass the transaction that recorded it, so the row
 * never commits holding the provisional word.
 */
export async function setDeliveryOutcome(tx: Executor, id: string, outcome: string): Promise<void> {
  await tx.update(githubDeliveries).set({ outcome }).where(eq(githubDeliveries.id, id))
}

/** Delete deliveries received before `olderThan`. Returns how many went. */
export async function pruneDeliveries(olderThan: Date): Promise<number> {
  const rows = await db
    .delete(githubDeliveries)
    .where(lt(githubDeliveries.receivedAt, olderThan))
    .returning({ id: githubDeliveries.id })
  return rows.length
}

/** The most recent delivery, for the Settings › GitHub "last delivery" line. */
export async function lastDelivery(): Promise<DeliveryRecord | undefined> {
  const [row] = await db
    .select()
    .from(githubDeliveries)
    .orderBy(desc(githubDeliveries.receivedAt))
    .limit(1)
  return row
}
