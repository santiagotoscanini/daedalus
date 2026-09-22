import type { Ctx } from '../../../core/ctx'
import { AGENT_PORT, type AgentStatus, agentStatus } from '../../../lib/agent/status'
import { getJsonResult } from '../../../lib/http'
import { listNodes, type NodeRow } from '../../../lib/repo/nodes'
import { type Device, lanDevices } from '../../network/data/dhcp'

// The other machines: what announced itself, and what was found.
//
// Two sources, one list. A machine that said hello (routes/api.nodes.hello)
// has a row in the nodes table keyed on its signing key, with a state the
// admin decides: pending, approved, revoked. A machine that merely answers
// the agent's status page on TCP 7787 is found by asking — pi-hole's
// network table knows everything on the LAN that ever asked for a name,
// and each address seen in the last week is probed in parallel with a
// short timeout. The two are joined on the address: a node's board shows
// the live page when it answers, and a page with no node behind it is a
// machine whose agent has not found the box (an older agent, or one on a
// LAN whose DNS is not the box's).
//
// Only the announced kind can be acted on, and only once approved: a
// status page has no identity, a signed hello does.

/** How long a device may have been silent and still be asked. */
const RECENT_SECS = 7 * 86_400
/** One attempt, short: a machine without the agent refuses at once; one that
 * is asleep or gone times out, and there is nothing to wait for. */
const PROBE_MS = [1_500]

export type Machine = {
  /** The node row, when the machine has said hello. */
  node: NodeRow | null
  /** What this house calls it on the LAN, when pi-hole knows it. */
  lanName: string | null
  ip: string | null
  /** Seconds since pi-hole last heard from it; null when unknown. */
  lastResolvedAgo: number | null
  /** The status page, when it answered just now. */
  status: AgentStatus | null
}

export type MachinesData = {
  port: number
  /** How many addresses were asked. */
  probed: number
  /** Devices that were on the table but too old to ask. */
  skipped: number
  machines: Machine[]
  /** Why the LAN list could not be read, when it could not. */
  error: string | null
}

async function probe(ip: string, port: number): Promise<AgentStatus | null> {
  const r = await getJsonResult<unknown>(`http://${ip}:${port}/status`, {}, PROBE_MS)
  if (!r.ok) return null
  try {
    return agentStatus(r.value)
  } catch {
    // Something answered on the port with JSON that is not a status page.
    return null
  }
}

/** The order the page reads in: what needs a decision, then what is trusted, then the rest. */
const RANK: Record<string, number> = { pending: 0, approved: 1, found: 2, revoked: 3 }

function rank(m: Machine): number {
  return RANK[m.node?.state ?? 'found'] ?? 9
}

function label(m: Machine): string {
  return m.status?.hostname || m.node?.hostname || m.lanName || m.ip || ''
}

export async function loadMachines(ctx: Ctx): Promise<MachinesData> {
  const port = AGENT_PORT
  const nodeRows = await listNodes()

  let devices: Device[] = []
  let error: string | null = null
  try {
    devices = await lanDevices(ctx)
  } catch (e) {
    error = e instanceof Error ? e.message : 'the LAN device list could not be read'
  }
  const self = ctx.env('LAN_IP') ?? ''
  const recent = devices.filter(
    (d) => d.ip !== '?' && d.ip !== self && d.lastSeenAgo !== null && d.lastSeenAgo < RECENT_SECS,
  )

  // Every address worth asking: the recent LAN, plus wherever a node last
  // said it was, in case pi-hole has not heard from it.
  const addresses = new Set<string>(recent.map((d) => d.ip))
  for (const n of nodeRows) if (n.lanIp !== null && n.lanIp !== self) addresses.add(n.lanIp)
  const answers = new Map<string, AgentStatus | null>()
  await Promise.all(
    [...addresses].map(async (ip) => {
      answers.set(ip, await probe(ip, port))
    }),
  )

  const byIp = new Map(devices.map((d) => [d.ip, d]))
  const claimed = new Set<string>()
  const machines: Machine[] = nodeRows.map((n) => {
    const ip = n.lanIp
    if (ip !== null) claimed.add(ip)
    const dev = ip === null ? undefined : byIp.get(ip)
    return {
      node: n,
      lanName: dev?.name ?? null,
      ip,
      lastResolvedAgo: dev?.lastSeenAgo ?? null,
      status: ip === null ? null : (answers.get(ip) ?? null),
    }
  })
  for (const d of recent) {
    const status = answers.get(d.ip) ?? null
    if (status === null || claimed.has(d.ip)) continue
    machines.push({ node: null, lanName: d.name, ip: d.ip, lastResolvedAgo: d.lastSeenAgo, status })
  }
  machines.sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)))

  return {
    port,
    probed: addresses.size,
    skipped: devices.length - recent.length,
    machines,
    error,
  }
}
