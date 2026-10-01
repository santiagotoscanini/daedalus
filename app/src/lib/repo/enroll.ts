import { eq, lt, or } from 'drizzle-orm'
import { db } from '../../host/db'
import type { EnrollStore, NodeStanding } from '../../host/enroll'
import { enrollCodes, nodes, nodeTunnels } from '../../host/schema'

// The database under a Mac's log-in (host/enroll.ts): the node's standing,
// which wg-easy client is whose, and the single-use codes.

const standingOf = (n: {
  state: NodeStanding['state']
  approvedAt: Date | null
  approvedBy: string | null
  revokedAt: Date | null
}): NodeStanding => ({
  state: n.state,
  approvedAt: n.approvedAt,
  approvedBy: n.approvedBy,
  revokedAt: n.revokedAt,
})

async function standing(id: string): Promise<NodeStanding | null> {
  const [n] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1)
  return n === undefined ? null : standingOf(n)
}

export const enrollStore: EnrollStore = {
  standing,

  approve: async (r) =>
    db.transaction(async (tx) => {
      const [n] = await tx.select().from(nodes).where(eq(nodes.id, r.id)).limit(1).for('update')
      const now = new Date()
      if (n !== undefined) {
        await tx
          .update(nodes)
          .set({ state: 'approved', approvedAt: now, approvedBy: r.by, revokedAt: null })
          .where(eq(nodes.id, r.id))
        return standingOf(n)
      }
      // A new row carries the page's facts until the machine's first hello
      // replaces them (lib/repo/nodes.ts recordObserved).
      await tx.insert(nodes).values({
        id: r.id,
        publicKey: r.publicKey,
        state: 'approved',
        hostname: r.hostname,
        os: r.os,
        arch: r.arch,
        agentVersion: r.agentVersion,
        firstSeenAt: now,
        lastSeenAt: now,
        approvedAt: now,
        approvedBy: r.by,
      })
      return null
    }),

  restore: async (id, prior) => {
    if (prior === null) {
      await db.delete(nodes).where(eq(nodes.id, id))
      return
    }
    await db.update(nodes).set(prior).where(eq(nodes.id, id))
  },

  tunnelOf: async (id) => {
    const [t] = await db.select().from(nodeTunnels).where(eq(nodeTunnels.nodeId, id)).limit(1)
    return t === undefined ? null : { clientId: t.clientId, address: t.address }
  },

  setTunnel: async (id, t) => {
    await db
      .insert(nodeTunnels)
      .values({ nodeId: id, clientId: t.clientId, address: t.address })
      .onConflictDoUpdate({
        target: nodeTunnels.nodeId,
        set: { clientId: t.clientId, address: t.address, createdAt: new Date() },
      })
  },

  deleteTunnel: async (id) => {
    await db.delete(nodeTunnels).where(eq(nodeTunnels.nodeId, id))
  },

  putCode: async (row) => {
    // Codes nobody redeemed go with the next one made: this machine's, and any expired.
    await db.transaction(async (tx) => {
      await tx
        .delete(enrollCodes)
        .where(or(eq(enrollCodes.nodeId, row.nodeId), lt(enrollCodes.expiresAt, new Date())))
      await tx.insert(enrollCodes).values(row)
    })
  },

  takeCode: async (hash) => {
    const [row] = await db.delete(enrollCodes).where(eq(enrollCodes.codeHash, hash)).returning()
    return row ?? null
  },
}

/** Retention: delete the codes past their expiry nobody redeemed. Returns how many went. */
export async function pruneExpiredEnrollCodes(now: Date): Promise<number> {
  const rows = await db
    .delete(enrollCodes)
    .where(lt(enrollCodes.expiresAt, now))
    .returning({ hash: enrollCodes.codeHash })
  return rows.length
}
