import { desc, eq } from 'drizzle-orm'
import type { HelloVerdict } from '../../host/agent-hello'
import { db } from '../../host/db'
import { type NodePolicy, type NodeState, nodes } from '../../host/schema'

// The nodes table: what a verified hello writes, what the Machines tab and
// the Claude page read, the decisions an admin makes about a row, and the
// policy Settings › Machines sets on it.

/**
 * Claude Code on the node, as the last hello summarised it (agent/src/
 * claude.rs `Summary`). Read out of the hello payload rather than columns:
 * it is the agent's word, refreshed every minute, and nothing here joins
 * on it.
 */
export type NodeClaudeSummary = {
  state: string
  cliVersion: string | null
  serverVersion: string | null
  environmentId: string | null
  sessions: number
  startedAt: string | null
  subscriptionType: string | null
  refreshExpiresAt: number | null
}

export type NodeRow = {
  id: string
  publicKey: string
  state: NodeState
  hostname: string
  /** The policy's display name, or the hostname. */
  name: string
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
  updateCheckRequested: boolean
  claudeRestartRequested: boolean
  policy: NodePolicy
  /** Present once the node's tray has reported Claude Code (agent 0.4.0+). */
  claude: NodeClaudeSummary | null
  /** Seconds since the last hello, resolved on the server (the page streams). */
  lastSeenAgo: number
}

/** The agent's own defaults, shown for a key the policy does not set. */
export const POLICY_DEFAULTS = { awakeHold: true, claudeRemoteControl: true } as const

/** The policy the answer to a hello carries: every key resolved. */
export function effectivePolicy(p: NodePolicy): {
  awakeHold: boolean
  claudeRemoteControl: boolean
} {
  return {
    awakeHold: p.awakeHold ?? POLICY_DEFAULTS.awakeHold,
    claudeRemoteControl: p.claudeRemoteControl ?? POLICY_DEFAULTS.claudeRemoteControl,
  }
}

function claudeOf(hello: Record<string, unknown>): NodeClaudeSummary | null {
  const c = hello.claude
  if (typeof c !== 'object' || c === null) return null
  const o = c as Record<string, unknown>
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null)
  return {
    state: s('state') ?? 'stopped',
    cliVersion: s('cli_version'),
    serverVersion: s('server_version'),
    environmentId: s('environment_id'),
    sessions: typeof o.sessions === 'number' ? o.sessions : 0,
    startedAt: s('started_at'),
    subscriptionType: s('subscription_type'),
    refreshExpiresAt: typeof o.refresh_expires_at === 'number' ? o.refresh_expires_at : null,
  }
}

function row(n: typeof nodes.$inferSelect): NodeRow {
  const policy = n.policy ?? {}
  return {
    id: n.id,
    publicKey: n.publicKey,
    state: n.state,
    hostname: n.hostname,
    name: policy.displayName?.trim() || n.hostname,
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
    updateCheckRequested: n.updateCheckRequested,
    claudeRestartRequested: n.claudeRestartRequested,
    policy,
    claude: claudeOf(n.lastHello),
    lastSeenAgo: (Date.now() - n.lastSeenAt.getTime()) / 1000,
  }
}

export async function listNodes(): Promise<NodeRow[]> {
  const all = await db.select().from(nodes).orderBy(desc(nodes.lastSeenAt))
  return all.map(row)
}

export async function getNode(id: string): Promise<NodeRow | null> {
  const [n] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1)
  return n === undefined ? null : row(n)
}

/**
 * What the answer to a hello carries: the decision, the policy (only for an
 * approved node — before that the agent's own defaults stand), and the
 * instructions.
 */
export type HelloAnswer = {
  state: NodeState
  checkUpdate: boolean
  restartClaude: boolean
  policy: { awakeHold: boolean; claudeRemoteControl: boolean } | null
}

/**
 * Record a verified hello. A first hello inserts the row as `pending`; every
 * later one refreshes what the machine says about itself and when. The
 * state is never touched here — only an admin moves it — and the answer is
 * what the agent shows: whether it is waiting, trusted, or turned away.
 */
export async function recordHello(v: Extract<HelloVerdict, { ok: true }>): Promise<HelloAnswer> {
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
    .returning({
      state: nodes.state,
      checkUpdate: nodes.updateCheckRequested,
      restartClaude: nodes.claudeRestartRequested,
      policy: nodes.policy,
    })
  const state = saved?.state ?? 'pending'
  const checkUpdate = saved?.checkUpdate === true
  const restartClaude = saved?.restartClaude === true
  // An instruction is delivered once: it goes out with this answer and is
  // cleared in the same breath, so a second hello does not repeat it.
  if (checkUpdate || restartClaude) {
    await db
      .update(nodes)
      .set({ updateCheckRequested: false, claudeRestartRequested: false })
      .where(eq(nodes.id, v.nodeId))
  }
  return {
    state,
    checkUpdate,
    restartClaude,
    policy: state === 'approved' ? effectivePolicy(saved?.policy ?? {}) : null,
  }
}

/** Ask the node to check for updates on its next hello. */
export async function requestUpdateCheck(id: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ updateCheckRequested: true })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  return updated.length > 0
}

/** Ask the node's tray to restart `claude remote-control` on its next hello. */
export async function requestClaudeRestart(id: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ claudeRestartRequested: true })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  return updated.length > 0
}

/**
 * Replace the node's policy. The whole object, so a key the page cleared
 * goes back to the agent's default rather than lingering.
 */
export async function setNodePolicy(id: string, policy: NodePolicy): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ policy })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  return updated.length > 0
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
