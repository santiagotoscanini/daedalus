import { desc, eq } from 'drizzle-orm'
import type { HelloVerdict } from '../../host/agent-hello'
import { db } from '../../host/db'
import { type NodeState, nodes } from '../../host/schema'

// The nodes table: what a verified hello writes, what the Machines tab
// reads, and the two decisions an admin makes about a row.

export type NodeRow = {
  id: string
  publicKey: string
  state: NodeState
  hostname: string
  os: string
  arch: string
  agentVersion: string
  mac: string | null
  lanIp: string | null
  statusPort: number | null
  firstSeenAt: string
  lastSeenAt: string
  approvedAt: string | null
  approvedBy: string | null
  revokedAt: string | null
  /** Seconds since the last hello, resolved on the server (the page streams). */
  lastSeenAgo: number
}

function row(n: typeof nodes.$inferSelect): NodeRow {
  return {
    id: n.id,
    publicKey: n.publicKey,
    state: n.state,
    hostname: n.hostname,
    os: n.os,
    arch: n.arch,
    agentVersion: n.agentVersion,
    mac: n.mac,
    lanIp: n.lanIp,
    statusPort: n.statusPort,
    firstSeenAt: n.firstSeenAt.toISOString(),
    lastSeenAt: n.lastSeenAt.toISOString(),
    approvedAt: n.approvedAt?.toISOString() ?? null,
    approvedBy: n.approvedBy,
    revokedAt: n.revokedAt?.toISOString() ?? null,
    lastSeenAgo: (Date.now() - n.lastSeenAt.getTime()) / 1000,
  }
}

export async function listNodes(): Promise<NodeRow[]> {
  const all = await db.select().from(nodes).orderBy(desc(nodes.lastSeenAt))
  return all.map(row)
}

/**
 * Record a verified hello. A first hello inserts the row as `pending`; every
 * later one refreshes what the machine says about itself and when. The
 * state is never touched here — only an admin moves it — and the answer is
 * what the agent shows: whether it is waiting, trusted, or turned away.
 */
export async function recordHello(v: Extract<HelloVerdict, { ok: true }>): Promise<NodeState> {
  const p = v.payload
  const now = new Date()
  const [saved] = await db
    .insert(nodes)
    .values({
      id: v.nodeId,
      publicKey: v.publicKey,
      hostname: p.hostname,
      os: p.os,
      arch: p.arch,
      agentVersion: p.agentVersion,
      mac: p.mac,
      lanIp: p.lanIp,
      statusPort: p.statusPort,
      lastHello: v.raw,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .onConflictDoUpdate({
      target: nodes.id,
      set: {
        hostname: p.hostname,
        os: p.os,
        arch: p.arch,
        agentVersion: p.agentVersion,
        mac: p.mac,
        lanIp: p.lanIp,
        statusPort: p.statusPort,
        lastHello: v.raw,
        lastSeenAt: now,
      },
    })
    .returning({ state: nodes.state })
  return saved?.state ?? 'pending'
}

export async function approveNode(id: string, by: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ state: 'approved', approvedAt: new Date(), approvedBy: by, revokedAt: null })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  return updated.length > 0
}

export async function revokeNode(id: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ state: 'revoked', revokedAt: new Date() })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  return updated.length > 0
}

/** Forget a row entirely — for a machine that is gone, or a key that was a mistake. */
export async function forgetNode(id: string): Promise<boolean> {
  const gone = await db.delete(nodes).where(eq(nodes.id, id)).returning({ id: nodes.id })
  return gone.length > 0
}
