import { createHash } from 'node:crypto'
import type { Ctx } from '../../core/ctx'
import { wireName, wirePolicy } from '../../lib/agent/policy'
import type { NodePolicy, NodeState } from '../schema'
import {
  ControllerError,
  type ControllerNode,
  type ControllerNodeDetail,
  type DesiredNode,
  type SetDesiredOk,
} from './wire'

// The machines, as the app handles them through the controller: the agent on
// the box, which every other machine keeps one link to (agent/README.md "The
// link to the controller"). The split is PLAN feature 13's: the app owns the
// DESIRED state — which keys are approved or revoked, and each approved
// machine's policy — in the `nodes` table, and hands the controller the whole
// set; the controller holds the OBSERVED state — who is connected, their
// status, telemetry and Claude report — in memory, and forgets it on a
// restart.
//
// So the set is sent whenever it could differ from what the controller holds:
// on every (re)connection (the client's onConnect, ./client.ts), and after
// every decision or policy save (lib/repo/nodes.ts). It is idempotent — the
// controller applies it as a difference — and serialised here, so two saves
// in a row never race each other's sets. `ensureControllerLink` runs every
// minute (from /api/healthz, like the build scheduler) to re-dial a
// controller that restarted while nothing asked, and to keep each approved
// row's last-known facts (address, versions, last seen) from what the
// controller observed: the DHCP lines are rendered from them.

const HEX32 = /^[0-9a-f]{64}$/

/** A machine's id: the first sixteen hex characters of SHA-256(public key). */
export function nodeIdOf(publicKeyHex: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 16)
}

/** What the desired set is built from: one row of the nodes table. */
export type DecidedRow = {
  id: string
  publicKey: string
  state: NodeState
  policy: NodePolicy | null
}

/** An approved key's entry: its policy and, when it has one, the name the pages show. */
function approvedEntry(id: string, key: string, policy: NodePolicy): DesiredNode {
  const name = wireName(policy)
  return {
    id,
    public_key: key,
    state: 'approved',
    policy: wirePolicy(policy),
    ...(name === undefined ? {} : { name }),
  }
}

/**
 * The complete set `nodes.set_desired` takes: every approved key with its
 * policy and display name, every revoked key without either, sorted by id.
 * The name is the `machine` label of the machine's series in the
 * controller's `/nodes/metrics`. A row whose id is not
 * its key's is left out and named — the controller checks every entry before
 * applying any, so one bad row would refuse the lot.
 */
export function desiredSet(rows: readonly DecidedRow[]): {
  nodes: DesiredNode[]
  skipped: { id: string; reason: string }[]
} {
  const nodes: DesiredNode[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const r of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const key = r.publicKey.toLowerCase()
    if (!HEX32.test(key)) {
      skipped.push({ id: r.id, reason: 'the stored key is not 64 hex characters' })
      continue
    }
    if (nodeIdOf(key) !== r.id) {
      skipped.push({ id: r.id, reason: 'the id is not the key’s' })
      continue
    }
    nodes.push(
      r.state === 'approved'
        ? approvedEntry(r.id, key, r.policy ?? {})
        : { id: r.id, public_key: key, state: 'revoked' },
    )
  }
  return { nodes, skipped }
}

/** The last sync, for Settings › Machines and the log. */
export type DesiredSync = {
  at: string
  /** What was sent: id and state per key. */
  sent: { id: string; state: 'approved' | 'revoked' }[]
  skipped: { id: string; reason: string }[]
  answer: SetDesiredOk | null
  error: string | null
}

type Slot = {
  tail: Promise<unknown>
  queued: Promise<DesiredSync> | null
  last: DesiredSync | null
}
const SLOT = Symbol.for('daedalus.controller.desired')
function slot(): Slot {
  const g = globalThis as unknown as Record<symbol, Slot | undefined>
  let s = g[SLOT]
  if (s === undefined) {
    s = { tail: Promise.resolve(), queued: null, last: null }
    g[SLOT] = s
  }
  return s
}

async function decidedRows(): Promise<DecidedRow[]> {
  const { db } = await import('../db')
  const { nodes } = await import('../schema')
  return db
    .select({ id: nodes.id, publicKey: nodes.publicKey, state: nodes.state, policy: nodes.policy })
    .from(nodes)
}

type Rows = () => Promise<DecidedRow[]>

async function runSync(ctx: Pick<Ctx, 'controller'>, rows: Rows): Promise<DesiredSync> {
  const at = new Date().toISOString()
  let sent: DesiredSync['sent'] = []
  let skipped: DesiredSync['skipped'] = []
  let result: DesiredSync
  try {
    const set = desiredSet(await rows())
    sent = set.nodes.map((n) => ({ id: n.id, state: n.state }))
    skipped = set.skipped
    const answer = await ctx.controller.nodesSetDesired(set.nodes)
    result = { at, sent, skipped, answer, error: null }
  } catch (e) {
    result = { at, sent, skipped, answer: null, error: e instanceof Error ? e.message : String(e) }
  }
  slot().last = result
  console.info(
    `controller: set_desired ${JSON.stringify({ sent: result.sent, skipped: result.skipped })} → ${
      result.error === null ? JSON.stringify(result.answer) : `failed: ${result.error}`
    }`,
  )
  return result
}

/**
 * Hand the controller the complete desired set, now. Never throws: the
 * result, error included, is also kept for `lastDesiredSync`. Calls made
 * while one is queued share it; one made while a sync runs queues the next,
 * which reads the table afresh.
 */
export function syncDesired(
  ctx: Pick<Ctx, 'controller'>,
  rows: Rows = decidedRows,
): Promise<DesiredSync> {
  const s = slot()
  if (s.queued !== null) return s.queued
  const q = s.tail.then(() => {
    s.queued = null
    return runSync(ctx, rows)
  })
  s.queued = q
  s.tail = q.catch(() => undefined)
  return q
}

/** A sync, not awaited, on its own Ctx: for a decision that must not wait on the controller. */
export function requestDesiredSync(): void {
  void import('../../core/ctx')
    .then(async ({ makeCtx }) => syncDesired(await makeCtx()))
    .catch((e: unknown) => {
      console.warn(`controller: no desired sync: ${e instanceof Error ? e.message : String(e)}`)
    })
}

export function lastDesiredSync(): DesiredSync | null {
  return slot().last
}

/**
 * What the controller observed about an approved machine that its row does
 * not say yet: the columns to update, or null when nothing moved. Only from
 * a summary that carries the hello (the controller has heard from the
 * machine since it started); a field the machine did not report keeps the
 * row's value.
 */
export function observedFacts(
  row: {
    hostname: string
    os: string
    arch: string
    agentVersion: string
    mac: string | null
    lanIp: string | null
    lastSeenAt: Date
  },
  seen: ControllerNode,
): {
  hostname?: string
  os?: string
  arch?: string
  agentVersion?: string
  mac?: string
  lanIp?: string
  lastSeenAt?: Date
} | null {
  if (seen.hostname === null) return null
  const out: NonNullable<ReturnType<typeof observedFacts>> = {}
  if (seen.hostname !== row.hostname) out.hostname = seen.hostname
  if (seen.os !== null && seen.os !== row.os) out.os = seen.os
  if (seen.arch !== null && seen.arch !== row.arch) out.arch = seen.arch
  if (seen.agentVersion !== null && seen.agentVersion !== row.agentVersion) {
    out.agentVersion = seen.agentVersion
  }
  if (seen.mac !== null && seen.mac !== row.mac) out.mac = seen.mac
  if (seen.lanIp !== null && seen.lanIp !== row.lanIp) out.lanIp = seen.lanIp
  const last = seen.lastSeen === null ? Number.NaN : Date.parse(seen.lastSeen)
  if (Number.isFinite(last) && last > row.lastSeenAt.getTime()) out.lastSeenAt = new Date(last)
  return Object.keys(out).length === 0 ? null : out
}

/**
 * The row an approval creates for a key the controller holds pending: its
 * key and what its hello said. Throws, in words the page can show, when the
 * controller's answer is not a waiting key the app may take.
 */
export function enrollValues(d: ControllerNodeDetail): {
  id: string
  publicKey: string
  hostname: string
  os: string
  arch: string
  agentVersion: string
  mac: string | null
  lanIp: string | null
} {
  if (d.state !== 'pending') {
    throw new Error(`the controller holds ${d.id} as ${d.state}, not waiting for a decision`)
  }
  const key = d.publicKey.toLowerCase()
  if (!HEX32.test(key) || nodeIdOf(key) !== d.id) {
    throw new Error(`the controller's key for ${d.id} is not that id's`)
  }
  const h = d.hello
  if (h === null || h.hostname === '') {
    throw new Error(`the controller has no hello from ${d.id}; wait for it to connect`)
  }
  return {
    id: d.id,
    publicKey: key,
    hostname: h.hostname,
    os: h.os,
    arch: h.arch,
    agentVersion: h.agentVersion,
    mac: h.mac,
    lanIp: h.lanIp,
  }
}

/**
 * One machine as the controller holds it, or why not in words a page can
 * print after the machine's name.
 */
export async function readNode(
  ctx: Pick<Ctx, 'controller'>,
  id: string,
): Promise<{ detail: ControllerNodeDetail | null; error: string | null }> {
  try {
    return { detail: await ctx.controller.nodesGet(id), error: null }
  } catch (e) {
    if (e instanceof ControllerError && e.code === 'not_found') {
      return {
        detail: null,
        error: 'not connected, and the controller has not heard from it since it started',
      }
    }
    return { detail: null, error: `the controller: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * The minute's tick: re-dial the controller if the connection is gone (the
 * dial's onConnect re-sends the desired set), then keep the approved rows'
 * facts from what it observed. Never throws; a tick still running when the
 * next comes is not doubled.
 */
let ticking = false
export async function ensureControllerLink(ctx: Pick<Ctx, 'controller'>): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    if (ctx.controller.hello() === null) await ctx.controller.systemInfo()
    const seen = await ctx.controller.nodesList()
    const { recordObserved } = await import('../../lib/repo/nodes')
    await recordObserved(seen)
  } catch {
    // Not reachable, or the table: the next minute tries again, and the
    // pages say what the controller answered.
  } finally {
    ticking = false
  }
}
