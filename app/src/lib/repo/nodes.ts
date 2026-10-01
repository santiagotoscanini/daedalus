import { and, asc, eq, type SQL, sql } from 'drizzle-orm'
import type { Ctx } from '../../core/ctx'
import {
  enrollValues,
  observedFacts,
  requestDesiredSync,
  syncDesired,
} from '../../host/controller/nodes'
import type {
  ControllerNode,
  ControllerNodeDetail,
  NodePolicyChanges,
} from '../../host/controller/wire'
import { db } from '../../host/db'
import { dhcpHostsMissing, householdMacs, writeDhcpHosts } from '../../host/dhcp-hosts'
import { fingerprintOf, releaseTunnel } from '../../host/enroll'
import { requestGatewaySync } from '../../host/gateway-sync'
import { type NodePolicy, type NodeState, nodes } from '../../host/schema'
import type { NodeClaudeSummary } from '../agent/status'
import type { NodeForFile } from '../nodes-file'
import { slugOf } from '../nodes-file'
import { DEFAULT_PORT, NODE_PROVIDER_KINDS, type ProviderKind } from '../providers/kinds'
import { enrollStore } from './enroll'

// The nodes table: the machines the box has decided about, and what it asks
// of each. A row is born when an admin approves a key the controller holds
// pending (`enrollNode`), and carries the decision, the policy Settings ›
// Machines sets, and the machine's last-known facts — kept from what the
// controller observed (`recordObserved`), because the controller forgets
// everything when it restarts and the DHCP lines and the pages
// still need an address and a name. Whether a machine is connected, and its
// Claude summary, are the controller's word, joined in on every read.
//
// Every decision and policy save ends in a desired-state sync
// (host/controller/nodes.ts), which is how it reaches the machine, and a
// gateway sync (host/gateway-sync.ts), which is how its providers do.

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

export async function listNodes(ctx: Pick<Ctx, 'controller'>): Promise<NodeRow[]> {
  // In the order they joined, and never by when they last spoke: a picker
  // whose pills swap places between two loads because one machine spoke a
  // second later reads as a race, not as a list.
  const [all, household, seen] = await Promise.all([
    db.select().from(nodes).orderBy(asc(nodes.firstSeenAt), asc(nodes.id)),
    householdMacs(),
    seenById(ctx),
  ])
  return all.map((n) => row(n, household, seen))
}

export async function getNode(ctx: Pick<Ctx, 'controller'>, id: string): Promise<NodeRow | null> {
  const [[n], household, seen] = await Promise.all([
    db.select().from(nodes).where(eq(nodes.id, id)).limit(1),
    householdMacs(),
    seenById(ctx),
  ])
  return n === undefined ? null : row(n, household, seen)
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

/**
 * Change a node's policy from the page (`policyPatchSql`), recorded under
 * `by`. santree is turned ON only through `grantSantree`, never here.
 */
export async function setNodePolicy(id: string, p: PolicyPatch, by: string): Promise<boolean> {
  if (p.set.santree === true) {
    throw new Error('santree is turned on through its confirmation, never a policy patch')
  }
  // Two machines cannot share a name on the network: the lease, the
  // nodes.json entry and every consumer dial it.
  const name = p.set.name
  if (name !== undefined) {
    const others = await db.select().from(nodes)
    const taken = others.find((n) => n.id !== id && n.state === 'approved' && netNameOf(n) === name)
    if (taken !== undefined) {
      throw new Error(`"${name}" is already ${taken.hostname}'s name on the network`)
    }
  }
  const updated = await db
    .update(nodes)
    .set(patched(p, by))
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  await afterDecision()
  return updated.length > 0
}

/** Who a change asked for from the machine itself is recorded under. */
export const byNode = (id: string): string => `node:${id}`

/**
 * A machine asks for its own settings (the controller's
 * `nodes.policy_request`, decoded by host/controller/wire.ts
 * `nodePolicyRequest`): keep awake, Claude Remote Control, santree OFF. Only
 * the keys it sent are written, only into an approved row, and only when the
 * row does not hold them already; then the desired set goes to the
 * controller, which is what changes the machine. Never the DHCP lines or the
 * gateway: none of these keys moves either, and a DHCP write reloads
 * pi-hole for the whole house. True when the row changed.
 */
export async function applyNodePolicyRequest(
  id: string,
  changes: NodePolicyChanges,
): Promise<boolean> {
  // The decoder refused santree ON already; a door is checked where it opens.
  if ((changes as { santree?: boolean }).santree === true) {
    throw new Error(`${id} asked to turn santree on, which only an admin does`)
  }
  const set: NodePolicy = { ...changes }
  if (Object.keys(set).length === 0) return false
  const changed = await db
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
  const row = changed[0]
  if (row === undefined) return false
  const name = row.policy?.displayName?.trim() || row.hostname
  const said = Object.entries(set)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ')
  console.info(`nodes: ${id} (${name}) set ${said} from the machine`)
  requestDesiredSync()
  return true
}

/** How a santree grant ended (`grantSantree`). */
export type SantreeGrant = { ok: true; already: boolean } | { ok: false; reason: string }

/**
 * Turn santree on for machine `id` — a shell on the box as its operator,
 * who has root through sudo — once an admin confirmed it on a page that
 * showed the machine and its key. Only an approved row, only the key the
 * page showed (`fingerprint`, checked again against the row), only on a box
 * with a session host, recorded under `by`; then the desired set is sent and
 * its answer awaited, so the reply says what the controller took.
 */
export async function grantSantree(
  input: { id: string; fingerprint: string; by: string },
  deps: { sessionHost: () => Promise<boolean>; sync: () => Promise<void> } = {
    sessionHost: hasSessionHost,
    sync: syncNow,
  },
): Promise<SantreeGrant> {
  const [n] = await db.select().from(nodes).where(eq(nodes.id, input.id)).limit(1)
  if (n === undefined || n.state !== 'approved') {
    return { ok: false, reason: 'This machine is not approved.' }
  }
  const fingerprint = fingerprintOf(n.publicKey)
  if (fingerprint !== input.fingerprint) {
    return { ok: false, reason: 'This machine has another key now; reload the page.' }
  }
  if (n.policy?.santree === true) return { ok: true, already: true }
  if (!(await deps.sessionHost())) {
    return { ok: false, reason: 'This box runs no session host, so santree has nowhere to go.' }
  }
  const changed = await db
    .update(nodes)
    .set(patched({ set: { santree: true }, unset: [] }, input.by))
    .where(
      and(eq(nodes.id, input.id), eq(nodes.state, 'approved'), eq(nodes.publicKey, n.publicKey)),
    )
    .returning({ id: nodes.id })
  if (changed.length === 0) return { ok: false, reason: 'This machine changed; reload the page.' }
  console.info(`nodes: ${input.id} santree turned on by ${input.by}`)
  await deps.sync()
  return { ok: true, already: false }
}

/** Whether this box runs a session host santree can reach. */
async function hasSessionHost(): Promise<boolean> {
  const { makeCtx } = await import('../../core/ctx')
  const { readSessionHost } = await import('../../host/session-host')
  return (await readSessionHost(await makeCtx())) !== null
}

/** Approve a row the table already holds (a revoked key, trusted again). */
export async function approveNode(id: string, by: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ state: 'approved', approvedAt: new Date(), approvedBy: by, revokedAt: null })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  await afterDecision()
  return updated.length > 0
}

/**
 * Approve a key the controller holds pending: the row is made from its key
 * and its hello, approved in the same write.
 */
export async function enrollNode(detail: ControllerNodeDetail, by: string): Promise<boolean> {
  const v = enrollValues(detail)
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
  await afterDecision()
  return made.length > 0
}

export async function revokeNode(id: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ state: 'revoked', revokedAt: new Date() })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  await afterDecision()
  if (updated.length > 0 && (await hasTunnel(id))) {
    // Told first, through the tunnel, so the machine forgets its log-in
    // rather than dialling a tunnel that is gone.
    await syncNow()
    await releaseTunnel({ store: enrollStore, wg: await boxWgEasy() }, id)
  }
  return updated.length > 0
}

/**
 * Forget a row entirely — for a machine that is gone, or a key that was a
 * mistake. Left out of the desired set, a key that connects again waits
 * pending, as a stranger's would.
 *
 * A logged-in machine (one with a tunnel) is revoked first and the
 * controller's answer awaited, so it hears `revoked` before its tunnel goes;
 * one that logged out itself (`left`, the controller's `nodes.left`) already
 * forgot, and only its tunnel and row go.
 */
export async function forgetNode(id: string, opts: { left?: boolean } = {}): Promise<boolean> {
  if (await hasTunnel(id)) {
    if (opts.left !== true) {
      const revoked = await db
        .update(nodes)
        .set({ state: 'revoked', revokedAt: new Date() })
        .where(eq(nodes.id, id))
        .returning({ id: nodes.id })
      if (revoked.length > 0) await syncNow()
    }
    await releaseTunnel({ store: enrollStore, wg: await boxWgEasy() }, id)
  }
  const gone = await db.delete(nodes).where(eq(nodes.id, id)).returning({ id: nodes.id })
  await afterDecision()
  return gone.length > 0
}

/** Whether the node logged in with a tunnel of its own; a table that cannot be read says no. */
async function hasTunnel(id: string): Promise<boolean> {
  try {
    return (await enrollStore.tunnelOf(id)) !== null
  } catch (e) {
    console.warn(`nodes: ${id}'s tunnel not read: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/** The desired set, sent and answered now (a decision's own sync is not awaited). */
async function syncNow(): Promise<void> {
  const { makeCtx } = await import('../../core/ctx')
  const s = await syncDesired(await makeCtx())
  if (s.error !== null) console.warn(`nodes: the controller did not take the set: ${s.error}`)
}

async function boxWgEasy() {
  const { wgEasy } = await import('../../host/wg-easy')
  return wgEasy()
}

/**
 * What follows every decision about a machine and every policy save: its DHCP
 * line, the desired set that tells the controller, and the gateway — a machine
 * trusted, revoked or forgotten is one whose providers are routed or not, now
 * rather than at the next five-minute sync.
 */
async function afterDecision(): Promise<void> {
  await publishDhcpHosts()
  requestDesiredSync()
  requestGatewaySync()
}

/**
 * Keep each decided row's last-known facts from what the controller
 * observed (host/controller/nodes.ts `observedFacts`), and re-render the
 * DHCP lines when an address, a MAC or a name moved.
 */
export async function recordObserved(seen: readonly ControllerNode[]): Promise<void> {
  if (seen.length === 0) return
  const byId = new Map(seen.map((s) => [s.id, s]))
  const all = await db.select().from(nodes)
  let moved = dhcpHostsMissing()
  for (const n of all) {
    const s = byId.get(n.id)
    if (s === undefined || n.state !== 'approved') continue
    const facts = observedFacts(n, s)
    if (facts === null) continue
    await db.update(nodes).set(facts).where(eq(nodes.id, n.id))
    if (facts.lanIp !== undefined || facts.mac !== undefined || facts.hostname !== undefined) {
      moved = true
    }
  }
  if (moved) await publishDhcpHosts()
}

/**
 * Write the approved nodes' dnsmasq lines (host/dhcp-hosts.ts): how each
 * machine gets its name from pi-hole. A MAC the household file already
 * names is theirs to name, and skipped. Best effort: a failure to write the
 * file is logged and never fails the decision that triggered it — the lines
 * are a consequence, not the act.
 */
async function publishDhcpHosts(): Promise<void> {
  try {
    const all = await db.select().from(nodes)
    const household = await householdMacs()
    await writeDhcpHosts(
      all
        .filter((n) => n.state === 'approved')
        .filter((n) => n.mac !== null && !household.has(n.mac.toLowerCase()))
        .map((n) => ({
          id: n.id,
          mac: n.mac ?? '',
          name: netNameOf(n),
          lanIp: n.policy?.pinAddress === true ? n.lanIp : null,
        })),
    )
  } catch (e) {
    console.warn(`dhcp hosts not written: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** What an Apply writes to site/nodes.json: the approved nodes, resolved (lib/nodes-file.ts). */
export async function nodesForFile(): Promise<NodeForFile[]> {
  const all = await db.select().from(nodes)
  return all
    .filter((n) => n.state === 'approved')
    .map((n) => ({
      id: n.id,
      name: netNameOf(n),
      os: n.os,
      providers: providersOf(n.policy ?? {}),
    }))
}
