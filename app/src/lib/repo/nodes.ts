import { randomBytes } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import type { HelloVerdict } from '../../host/agent-hello'
import { db } from '../../host/db'
import { requestGatewaySync } from '../../host/gateway-sync'
import {
  householdMacs,
  nodeTargetsMissing,
  writeDhcpHosts,
  writeNodeTargets,
} from '../../host/node-targets'
import { type NodePolicy, type NodeState, nodes } from '../../host/schema'
import type { NodeForFile } from '../nodes-file'
import { slugOf } from '../nodes-file'
import { DEFAULT_PORT, NODE_PROVIDER_KINDS, type ProviderKind } from '../providers/kinds'

// The nodes table: what a verified hello writes, what the Machines tab and
// the Claude page read, the decisions an admin makes about a row, and the
// policy Settings › Machines sets on it.

/**
 * Claude Code on the node, as the last hello summarised it (agent/src/
 * claude/mod.rs `Summary`): what the open page also carries — a state, versions
 * and a count, never a session's name, path or id. Read out of the hello
 * payload rather than columns: it is the agent's word, refreshed every
 * minute, and nothing here joins on it.
 */
type NodeClaudeSummary = {
  state: string
  detail: string | null
  cliVersion: string | null
  serverVersion: string | null
  sessions: number
  startedAt: string | null
  signedIn: boolean
}

export type NodeRow = {
  id: string
  publicKey: string
  state: NodeState
  hostname: string
  /** The policy's display name, or the hostname. */
  name: string
  /** What it is called on the network: the policy's label, or the hostname's slug. */
  netName: string
  /**
   * The household's encrypted reservations already name this MAC: the box
   * writes no line for it, and the name in effect is theirs (host/node-targets.ts).
   */
  namedByHousehold: boolean
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
  claudeUpdateRequested: boolean
  claudeRestartRequested: boolean
  policy: NodePolicy
  /** Present once the node's tray has reported Claude Code. */
  claude: NodeClaudeSummary | null
  /** Seconds since the last hello, resolved on the server (the page streams). */
  lastSeenAgo: number
}

/** The agent's own defaults, shown for a key the policy does not set. */
const POLICY_DEFAULTS = { awakeHold: true, claudeRemoteControl: true } as const

/** The policy the answer to a hello carries: every key resolved; `offer` stays here. */
function effectivePolicy(p: NodePolicy): {
  awakeHold: boolean
  claudeRemoteControl: boolean
  claudeWorkdir: string | null
  providers: Record<ProviderKind, { port: number }>
} {
  return {
    awakeHold: p.awakeHold ?? POLICY_DEFAULTS.awakeHold,
    claudeRemoteControl: p.claudeRemoteControl ?? POLICY_DEFAULTS.claudeRemoteControl,
    claudeWorkdir: p.claudeWorkdir?.trim() || null,
    // Every kind a node can offer, with the port it would be probed on: the
    // agent looks for the ones it implements and ignores the rest, so a kind
    // added here before the agent knows it is harmless.
    providers: Object.fromEntries(
      NODE_PROVIDER_KINDS.map((k) => [k, { port: p.providers?.[k]?.port ?? DEFAULT_PORT[k] }]),
    ) as Record<ProviderKind, { port: number }>,
  }
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

function claudeOf(hello: Record<string, unknown>): NodeClaudeSummary | null {
  const c = hello.claude
  if (typeof c !== 'object' || c === null) return null
  const o = c as Record<string, unknown>
  const s = (k: string) => (typeof o[k] === 'string' ? (o[k] as string) : null)
  return {
    state: s('state') ?? 'stopped',
    detail: s('detail'),
    cliVersion: s('cli_version'),
    serverVersion: s('server_version'),
    sessions: typeof o.sessions === 'number' ? o.sessions : 0,
    startedAt: s('started_at'),
    signedIn: o.signed_in === true,
  }
}

function row(n: typeof nodes.$inferSelect, household: ReadonlySet<string>): NodeRow {
  const policy = n.policy ?? {}
  return {
    id: n.id,
    publicKey: n.publicKey,
    state: n.state,
    hostname: n.hostname,
    name: policy.displayName?.trim() || n.hostname,
    netName: netNameOf(n),
    namedByHousehold: n.mac !== null && household.has(n.mac.toLowerCase()),
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
    claudeUpdateRequested: n.claudeUpdateRequested,
    claudeRestartRequested: n.claudeRestartRequested,
    policy,
    claude: claudeOf(n.lastHello),
    lastSeenAgo: (Date.now() - n.lastSeenAt.getTime()) / 1000,
  }
}

export async function listNodes(): Promise<NodeRow[]> {
  // In the order they joined, and never by when they last spoke: a picker
  // whose pills swap places between two loads because one machine said
  // hello a second later reads as a race, not as a list.
  const all = await db.select().from(nodes).orderBy(asc(nodes.firstSeenAt), asc(nodes.id))
  const household = await householdMacs()
  return all.map((n) => row(n, household))
}

export async function getNode(id: string): Promise<NodeRow | null> {
  const [n] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1)
  return n === undefined ? null : row(n, await householdMacs())
}

/**
 * What the answer to a hello carries: the decision, the policy (only for an
 * approved node — before that the agent's own defaults stand), and the
 * instructions.
 */
export type HelloAnswer = {
  state: NodeState
  checkUpdate: boolean
  updateClaude: boolean
  restartClaude: boolean
  policy: ReturnType<typeof effectivePolicy> | null
  /** The node token for an approved node: what opens its full Claude report to the box. */
  nodeToken: string | null
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
  const [before] = await db
    .select({ lanIp: nodes.lanIp })
    .from(nodes)
    .where(eq(nodes.id, v.nodeId))
    .limit(1)
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
      updateClaude: nodes.claudeUpdateRequested,
      restartClaude: nodes.claudeRestartRequested,
      policy: nodes.policy,
      token: nodes.token,
    })
  const state = saved?.state ?? 'pending'
  const checkUpdate = saved?.checkUpdate === true
  const updateClaude = saved?.updateClaude === true
  const restartClaude = saved?.restartClaude === true
  // A machine whose address moved since the last hello moves its scrape
  // target too. Compared on the row before this write; a first hello is
  // pending and publishes nothing.
  if (
    state === 'approved' &&
    ((before?.lanIp ?? null) !== (p.lanIp ?? null) || nodeTargetsMissing())
  ) {
    await publishNodeTargets()
  }
  // A provider may have changed what it serves since the last hello: the
  // gateway sync runs soon, once for a burst of hellos.
  if (state === 'approved') requestGatewaySync()
  // An instruction is delivered once: it goes out with this answer and is
  // cleared in the same breath, so a second hello does not repeat it.
  if (checkUpdate || updateClaude || restartClaude) {
    await db
      .update(nodes)
      .set({
        updateCheckRequested: false,
        claudeUpdateRequested: false,
        claudeRestartRequested: false,
      })
      .where(eq(nodes.id, v.nodeId))
  }
  return {
    state,
    checkUpdate,
    updateClaude,
    restartClaude,
    policy: state === 'approved' ? effectivePolicy(saved?.policy ?? {}) : null,
    // Minted at approval (approveNode), cleared at revocation.
    nodeToken: state === 'approved' ? (saved?.token ?? null) : null,
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

/**
 * Ask the node's tray to update Claude Code on its next hello.
 *
 * Interrupts nothing: the new version installs beside the running one and
 * takes effect the next time the CLI starts, which is upstream's own model.
 * Moving the RUNNING server onto it is `requestClaudeRestart`, and that one
 * ends every session on the machine — which is why these are two verbs.
 */
export async function requestClaudeUpdate(id: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ claudeUpdateRequested: true })
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
  // Two machines cannot share a name on the network: the lease, the
  // nodes.json entry and every consumer dial it.
  if (policy.name !== undefined) {
    const others = await db.select().from(nodes)
    const taken = others.find(
      (n) => n.id !== id && n.state === 'approved' && netNameOf(n) === policy.name,
    )
    if (taken !== undefined) {
      throw new Error(`"${policy.name}" is already ${taken.hostname}'s name on the network`)
    }
  }
  const updated = await db
    .update(nodes)
    .set({ policy })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  await publishNodeTargets()
  // An alias, a mode or an offer changed: the gateway follows.
  requestGatewaySync()
  return updated.length > 0
}

export async function approveNode(id: string, by: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({
      state: 'approved',
      approvedAt: new Date(),
      approvedBy: by,
      revokedAt: null,
      token: mintToken(),
    })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  await publishNodeTargets()
  return updated.length > 0
}

export async function revokeNode(id: string): Promise<boolean> {
  const updated = await db
    .update(nodes)
    .set({ state: 'revoked', revokedAt: new Date(), token: null })
    .where(eq(nodes.id, id))
    .returning({ id: nodes.id })
  await publishNodeTargets()
  return updated.length > 0
}

/** Forget a row entirely — for a machine that is gone, or a key that was a mistake. */
export async function forgetNode(id: string): Promise<boolean> {
  const gone = await db.delete(nodes).where(eq(nodes.id, id)).returning({ id: nodes.id })
  await publishNodeTargets()
  return gone.length > 0
}

/** 32 random bytes as hex: what the box shows the agent to read its full report. */
function mintToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The token for one node, for the server-side loader that reads the
 * agent's `/claude` — never for a page. Null for a node that is not
 * approved or has not said hello since approval.
 */
export async function nodeToken(id: string): Promise<string | null> {
  const [n] = await db
    .select({ token: nodes.token, state: nodes.state })
    .from(nodes)
    .where(eq(nodes.id, id))
    .limit(1)
  return n?.state === 'approved' ? (n.token ?? null) : null
}

/**
 * Publish the approved nodes as scrape targets (host/node-targets.ts).
 * Best effort: a failure to write the file is logged and never fails the
 * decision that triggered it — the targets are a consequence, not the act.
 */
async function publishNodeTargets(): Promise<void> {
  try {
    const all = await db.select().from(nodes)
    const approved = all.filter((n) => n.state === 'approved')
    await writeNodeTargets(
      approved
        .filter((n) => n.lanIp !== null)
        .map((n) => ({
          id: n.id,
          hostname: n.hostname,
          name: (n.policy ?? {}).displayName?.trim() || n.hostname,
          os: n.os,
          lanIp: n.lanIp ?? '',
          statusPort: n.statusPort ?? 7787,
        })),
    )
    // The dnsmasq lines: how each machine gets its name from pi-hole. A MAC
    // the household file already names is theirs to name, and skipped.
    const household = await householdMacs()
    await writeDhcpHosts(
      approved
        .filter((n) => n.mac !== null && !household.has(n.mac.toLowerCase()))
        .map((n) => ({
          id: n.id,
          mac: n.mac ?? '',
          name: netNameOf(n),
          lanIp: n.policy?.pinAddress === true ? n.lanIp : null,
        })),
    )
  } catch (e) {
    console.warn(`node targets not written: ${e instanceof Error ? e.message : String(e)}`)
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
