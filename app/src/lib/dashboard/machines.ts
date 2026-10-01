import type { Ctx } from '../../core/ctx'
import type { ControllerClient } from '../../host/controller/client'
import type { NodeSummary, RotationInfo, StatusDocument } from '../../host/controller/generated'
import { type DesiredSync, lastDesiredSync, readNode } from '../../host/controller/nodes'
import { lanDomain } from '../../host/providers/fleet'
import { readSessionHost, type SessionHostLine } from '../../host/session-host'
import { listNodes, type NodeRow } from '../repo/nodes'

// The other machines, as Settings › Machines lists them — here rather than
// in a module's data tree because Settings is a route, not a dashboard
// module, and it reaches the box the way the module loaders do, through a
// Ctx.
//
// Two sources, one list, joined on the key's id. The nodes table holds the
// machines the box has decided about — approved or revoked — with their
// policy; the controller (the agent on the box every machine links to)
// holds who is connected now, and the keys that connected and wait for a
// decision. A waiting key has no row until an admin approves it, and its
// card shows both fingerprints so the machine's tray can be compared first.

export type Machine = {
  /** The decided row, once there is one. */
  node: NodeRow | null
  /** A key the controller holds pending, with no row yet. */
  pending: NodeSummary | null
  /** The machine's status document, while the controller holds one. */
  status: StatusDocument | null
  /** What it is, from its telemetry; null without one. */
  shape: MachineShape | null
}

/** What the telemetry says the machine IS, for the settings that depend on it. */
export type MachineShape = {
  /** "laptop" | "desktop" | …, from the chassis. */
  form: string | null
  /** The model or board product: "Mac15,7", "B650 AORUS ELITE AX". */
  model: string | null
}

/** The controller as an install command needs it: where to dial, which key to pin. */
export type ControllerView =
  | {
      reachable: true
      version: string
      /** The first `host:port` it advertises; null when it listens for no machine. */
      address: string | null
      /** The key to pin: during a rotation, already the new one. */
      fingerprint: string
      /** The rotation under way, or null. */
      rotation: RotationInfo | null
    }
  | { reachable: false; error: string }

export type MachinesData = {
  /** The domain a node's name sits under, as the box publishes it. */
  lanDomain: string
  controller: ControllerView
  /** The last desired-state sync, as the controller answered it. */
  sync: DesiredSync | null
  /** The session host's line; null on a box without one. */
  sessionHost: SessionHostLine | null
  machines: Machine[]
  /** Why the controller's list of machines could not be read, when it could not. */
  listError: string | null
}

/** The order the page reads in: what needs a decision, then what is trusted, then the rest. */
const RANK: Record<string, number> = { pending: 0, approved: 1, revoked: 2 }

/**
 * The decided rows, each with nothing yet, and after them every key the
 * controller holds pending that has no row — the join, before any machine
 * is read. A key the controller lists in any other state without a row (one
 * forgotten while it was connected) is not offered: it is pending again at
 * its next connection.
 */
export function joinMachines(rows: readonly NodeRow[], seen: readonly NodeSummary[]): Machine[] {
  const decided = new Set(rows.map((n) => n.id))
  const out: Machine[] = [
    ...rows.map((node) => ({ node, pending: null, status: null, shape: null })),
    ...seen
      .filter((s) => s.state === 'pending' && !decided.has(s.id))
      .map((pending) => ({ node: null, pending, status: null, shape: null })),
  ]
  const label = (m: Machine) => m.node?.name ?? m.pending?.hostname ?? m.pending?.id ?? ''
  const rank = (m: Machine) => RANK[m.node?.state ?? 'pending'] ?? 9
  return out.sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)))
}

async function controllerView(client: ControllerClient): Promise<ControllerView> {
  try {
    const info = await client.call('system.info')
    if (info.controller === null) {
      return { reachable: false, error: `the agent on the box runs as ${info.mode}` }
    }
    return {
      reachable: true,
      version: info.version,
      address: info.controller.advertise[0] ?? null,
      fingerprint: info.controller.fingerprint,
      rotation: info.controller.rotation,
    }
  } catch (e) {
    return { reachable: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function loadMachines(ctx: Ctx): Promise<MachinesData> {
  const client = ctx.controller
  // Asked once: the rows join it in, and so do the cards.
  const listed = client.call('nodes.list').then(
    ({ nodes }) => ({ list: nodes, error: null }),
    (e: unknown) => ({
      list: [] as NodeSummary[],
      error: e instanceof Error ? e.message : String(e),
    }),
  )
  const [rows, domain, view, sessionHost, seen] = await Promise.all([
    listed.then((s) => listNodes(ctx, s.error === null ? s.list : null)),
    lanDomain(),
    controllerView(client),
    readSessionHost(ctx),
    listed,
  ])
  const machines = await Promise.all(
    joinMachines(rows, seen.list).map(async (m) => {
      // Only a machine the box acts on is read further: a waiting key has
      // no status to show until it is approved.
      if (m.node === null || m.node.state !== 'approved' || !m.node.connected) return m
      const d = (await readNode(ctx, m.node.id)).detail
      const t = d?.telemetry ?? null
      return {
        ...m,
        status: d?.status ?? null,
        shape:
          t === null
            ? null
            : { form: t.machine.form, model: t.machine.board_product ?? t.machine.model },
      }
    }),
  )
  return {
    lanDomain: domain.domain,
    controller: view,
    sync: lastDesiredSync(),
    sessionHost,
    machines,
    listError: seen.error,
  }
}
