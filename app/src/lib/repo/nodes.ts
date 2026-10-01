import { and, asc, eq, ne, or, type SQL, sql } from 'drizzle-orm'
import type { Ctx } from '../../core/ctx'
import type { DecidedRow } from '../../host/controller/nodes'
import type { ControllerNode } from '../../host/controller/wire'
import { db } from '../../host/db'
import { householdMacs } from '../../host/dhcp-hosts'
import { fingerprintOf } from '../../host/enroll'
import { type NodePolicy, type NodeState, nodes } from '../../host/schema'
import type { NodeClaudeSummary } from '../agent/status'
import type { NodeForFile } from '../nodes-file'
import { slugOf } from '../nodes-file'
import { DEFAULT_PORT, NODE_PROVIDER_KINDS, type ProviderKind } from '../providers/kinds'

// The nodes table: the machines the box has decided about, and what it asks
// of each. A row is born when an admin approves a key the controller holds
// pending (`insertEnrolled`), and carries the decision, the policy Settings ›
// Machines sets, and the machine's last-known facts — kept from what the
// controller observed (`writeObserved`), because the controller forgets
// everything when it restarts and the DHCP lines and the pages
// still need an address and a name. Whether a machine is connected, and its
// Claude summary, are the controller's word, joined in on every read.
//
// This file is the rows: what a decision, a policy save or a sighting WRITES.
// What follows each — the desired-state sync, the gateway, the DHCP lines, a
// tunnel released — is core/nodes.ts.

export type NodeRow = {
  id: string
  publicKey: string
  /** The key as people compare it: what the machine's menu bar and santree show. */
  fingerprint: string
  state: NodeState
  hostname: string
  /** The policy's display name, or the hostname. */
  name: string
  /** What it is called on the network: the policy's label, or the hostname's slug. */
  netName: string
  /**
   * The household's encrypted reservations already name this MAC: the box
   * writes no line for it, and the name in effect is theirs (host/dhcp-hosts.ts).
   */
  namedByHousehold: boolean
  os: string
  arch: string
  agentVersion: string
  mac: string | null
  lanIp: string | null
  firstSeenAt: string
  lastSeenAt: string
  approvedAt: string | null
  approvedBy: string | null
  revokedAt: string | null
  policy: NodePolicy
  /** Who changed the policy last (an admin's label, or `node:<id>` for the machine itself), and when. */
  policyChangedBy: string | null
  policyChangedAt: string | null
  /**
   * Its link is up at the controller right now; null when the controller
   * could not be asked. Unknown is not "not connected": the box cannot see
   * the machine, which says nothing about the machine.
   */
  connected: boolean | null
  /** Claude Code there, from the controller's summary; null without one. */
  claude: NodeClaudeSummary | null
  /** Seconds since the controller last heard from it (resolved on the server; the page streams). */
  lastSeenAgo: number
}

/** The network name a row resolves to: the policy's label, else the hostname's slug. */
export function netNameOf(n: { hostname: string; policy: NodePolicy | null }): string {
  return n.policy?.name ?? slugOf(n.hostname)
}

/** The providers a row could offer, every key resolved, for site/nodes.json and the page. */
export function providersOf(p: NodePolicy): Record<ProviderKind, { port: number; offer: boolean }> {
  return Object.fromEntries(
    NODE_PROVIDER_KINDS.map((k) => [
      k,
      { port: p.providers?.[k]?.port ?? DEFAULT_PORT[k], offer: p.providers?.[k]?.offer ?? false },
    ]),
  ) as Record<ProviderKind, { port: number; offer: boolean }>
}

function row(
  n: typeof nodes.$inferSelect,
  household: ReadonlySet<string>,
  seen: Map<string, ControllerNode> | null,
): NodeRow {
  const s = seen?.get(n.id)
  const policy = n.policy ?? {}
  const heard = s?.lastSeen == null ? Number.NaN : Date.parse(s.lastSeen)
  const lastSeen = Math.max(n.lastSeenAt.getTime(), Number.isFinite(heard) ? heard : 0)
  return {
    id: n.id,
    publicKey: n.publicKey,
    fingerprint: fingerprintOf(n.publicKey),
    state: n.state,
    hostname: n.hostname,
    name: policy.displayName?.trim() || n.hostname,
    netName: netNameOf(n),
    namedByHousehold: n.mac !== null && household.has(n.mac.toLowerCase()),
    os: n.os,
    arch: n.arch,
    agentVersion: s?.agentVersion ?? n.agentVersion,
    mac: n.mac,
    lanIp: s?.lanIp ?? n.lanIp,
    firstSeenAt: n.firstSeenAt.toISOString(),
    lastSeenAt: new Date(lastSeen).toISOString(),
    approvedAt: n.approvedAt?.toISOString() ?? null,
    approvedBy: n.approvedBy,
    revokedAt: n.revokedAt?.toISOString() ?? null,
    policy,
    policyChangedBy: n.policyChangedBy,
    policyChangedAt: n.policyChangedAt?.toISOString() ?? null,
    connected: seen === null ? null : s?.connected === true,
    claude: s?.claude ?? null,
    lastSeenAgo: (Date.now() - lastSeen) / 1000,
  }
}

/** The controller's list by id; null when it cannot be read, and every link is then unknown. */
async function seenById(ctx: Pick<Ctx, 'controller'>): Promise<Map<string, ControllerNode> | null> {
  const list = await ctx.controller.nodesList().catch(() => null)
  return list === null ? null : new Map(list.map((s) => [s.id, s]))
}

/**
 * Every decided machine, with the controller's word joined in. `seen` is the
 * controller's list when the caller has already asked for it (null: it could
 * not be read); left out, it is asked here.
 */
export async function listNodes(
  ctx: Pick<Ctx, 'controller'>,
  seen?: readonly ControllerNode[] | null,
): Promise<NodeRow[]> {
  // In the order they joined, and never by when they last spoke: a picker
  // whose pills swap places between two loads because one machine spoke a
  // second later reads as a race, not as a list.
  const [all, household, byId] = await Promise.all([
    db.select().from(nodes).orderBy(asc(nodes.firstSeenAt), asc(nodes.id)),
    householdMacs(),
    seen === undefined ? seenById(ctx) : seen === null ? null : new Map(seen.map((s) => [s.id, s])),
  ])
  return all.map((n) => row(n, household, byId))
}

export async function getNode(ctx: Pick<Ctx, 'controller'>, id: string): Promise<NodeRow | null> {
  const [n, household, seen] = await Promise.all([nodeById(id), householdMacs(), seenById(ctx)])
  return n === undefined ? null : row(n, household, seen)
}

export type NodeRecord = typeof nodes.$inferSelect

export async function nodeById(id: string): Promise<NodeRecord | undefined> {
  const [n] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1)
  return n
}

export async function allNodeRows(): Promise<NodeRecord[]> {
  return db.select().from(nodes)
}

/** What the controller's desired set is built from (host/controller/nodes.ts `desiredSet`). */
export async function decidedRows(): Promise<DecidedRow[]> {
  return db
    .select({ id: nodes.id, publicKey: nodes.publicKey, state: nodes.state, policy: nodes.policy })
    .from(nodes)
}

/**
 * The hostname of another approved machine already called `name` on the
 * network, or null. Only the rows whose label is `name`, or who have none and
 * so go by their hostname's slug, are read.
 */
export async function netNameTakenBy(name: string, exceptId: string): Promise<string | null> {
  const candidates = await db
    .select()
    .from(nodes)
    .where(
      and(
        ne(nodes.id, exceptId),
        eq(nodes.state, 'approved'),
        or(sql`${nodes.policy}->>'name' = ${name}`, sql`${nodes.policy}->>'name' IS NULL`),
      ),
    )
  return candidates.find((n) => netNameOf(n) === name)?.hostname ?? null
}

/**
 * One change to a policy, by key: the keys in `set` take their values, the
 * keys in `unset` go back to the agent's defaults, and every other key is
 * left as it is in the row. A key's value is replaced whole (`providers`,
 * `hardware` included). Every writer patches — the page, a machine asking
 * from its menu bar, the santree grant — so two of them changing different
 * keys at once never undo each other: per key, the last writer wins.
 */
export type PolicyPatch = { set: NodePolicy; unset: readonly (keyof NodePolicy)[] }

/** The SQL a patch writes: `(policy - unset…) || set`, the row's other keys kept. */
export function policyPatchSql(p: PolicyPatch): SQL {
  const removed = p.unset.map((k) => sql` - ${k}::text`)
  return sql`(${nodes.policy}${sql.join(removed, sql``)}) || ${JSON.stringify(p.set)}::jsonb`
}

/** The columns a patch writes: the policy, and who changed it when. */
function patched(p: PolicyPatch, by: string) {
  return { policy: policyPatchSql(p), policyChangedBy: by, policyChangedAt: new Date() }
}

/** Who a change asked for from the machine itself is recorded under. */
export const byNode = (id: string): string => `node:${id}`

/** Patch a row's policy, recorded under `by`. True when the id named a row. */
export async function writePolicy(id: string, p: PolicyPatch, by: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set(patched(p, by))
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  return updated.length > 0
}

/**
 * Write the keys a machine asked for into its own row, as the machine — only
 * an approved row, and only when it does not hold them already. The row
 * written, or undefined when nothing changed.
 */
export async function writePolicyRequest(
  id: string,
  set: NodePolicy,
): Promise<{ id: string; hostname: string; policy: NodePolicy | null } | undefined> {
  const [changed] = await db
    .update(nodes)
    .set(patched({ set, unset: [] }, byNode(id)))
    .where(
      and(
        eq(nodes.id, id),
        eq(nodes.state, 'approved'),
        sql`NOT (${nodes.policy} @> ${JSON.stringify(set)}::jsonb)`,
      ),
    )
    .returning({ id: nodes.id, hostname: nodes.hostname, policy: nodes.policy })
  return changed
}

/** santree on, only while the row is approved and still holds `publicKey`. */
export async function writeSantreeOn(id: string, publicKey: string, by: string): Promise<boolean> {
  const changed = await db
    .update(nodes)
    .set(patched({ set: { santree: true }, unset: [] }, by))
    .where(and(eq(nodes.id, id), eq(nodes.state, 'approved'), eq(nodes.publicKey, publicKey)))
    .returning({ id: nodes.id })
  return changed.length > 0
}

export async function setApproved(id: string, by: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ state: 'approved', approvedAt: new Date(), approvedBy: by, revokedAt: null })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  return updated.length > 0
}

/** A new approved row for a key the controller held pending; false when the key has one. */
export async function insertEnrolled(
  v: {
    id: string
    publicKey: string
    hostname: string
    os: string
    arch: string
    agentVersion: string
    mac: string | null
    lanIp: string | null
  },
  by: string,
): Promise<boolean> {
  const now = new Date()
  const made = await db
    .insert(nodes)
    .values({
      ...v,
      state: 'approved',
      firstSeenAt: now,
      lastSeenAt: now,
      approvedAt: now,
      approvedBy: by,
    })
    .onConflictDoNothing()
    .returning({ id: nodes.id })
  return made.length > 0
}

export async function setRevoked(id: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ state: 'revoked', revokedAt: new Date() })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  return updated.length > 0
}

export async function deleteNode(id: string): Promise<boolean> {
  const gone = await db.delete(nodes).where(eq(nodes.id, id)).returning({ id: nodes.id })
  return gone.length > 0
}

/** The columns a sighting moved, per row (host/controller/nodes.ts `observedFacts`), in one transaction. */
export async function writeObserved(
  moved: readonly { id: string; facts: Partial<NodeRecord> }[],
): Promise<void> {
  if (moved.length === 0) return
  await db.transaction(async (tx) => {
    for (const m of moved) await tx.update(nodes).set(m.facts).where(eq(nodes.id, m.id))
  })
}

/** What an Apply writes to site/nodes.json: the approved nodes, resolved (lib/nodes-file.ts). */
export async function nodesForFile(): Promise<NodeForFile[]> {
  const all = await db.select().from(nodes).where(eq(nodes.state, 'approved'))
  return all.map((n) => ({
    id: n.id,
    name: netNameOf(n),
    os: n.os,
    providers: providersOf(n.policy ?? {}),
  }))
}
