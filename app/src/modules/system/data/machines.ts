import type { Ctx } from '../../../core/ctx'
import { AGENT_PORT, type AgentStatus, agentStatus } from '../../../lib/agent/status'
import { getJsonResult } from '../../../lib/http'
import { type Device, lanDevices } from '../../network/data/dhcp'

// The other machines: every device on the LAN that answers the agent's
// status page.
//
// Found by looking, not by being told. pi-hole's network table already
// knows everything on the LAN that has ever asked for a name — the same list
// the DHCP tab shows — and the agent answers one JSON document on TCP 7787
// for exactly this purpose. So the box asks each recently-seen address for
// that document, with a short timeout, and lists the ones that answer. Zero
// configuration on either side; a machine appears here the moment its agent
// runs.
//
// This is discovery, not enrollment. The page states what it can observe
// and nothing else: there is no identity behind a status page, and nothing
// here lets the box act on a machine. The signed hello and the approval that
// turn a discovered machine into a node the box trusts are the next step
// (PLAN.md, feature 6, phase two), and they will sit beside this list rather
// than replace it — a machine whose agent cannot find the box is still worth
// seeing.
//
// The probe costs one connection attempt per device, bounded by the timeout
// and run in parallel, so a page load waits at most one timeout. Addresses
// unseen for a week are skipped: the table keeps devices for months, and a
// laptop that left in June is not going to answer.

/** How long a device may have been silent and still be asked. */
const RECENT_SECS = 7 * 86_400
/** One attempt, short: a machine without the agent refuses at once; one that
 * is asleep or gone times out, and there is nothing to wait for. */
const PROBE_MS = [1_500]

export type Machine = {
  /** What this house calls it (the DHCP reservation), else what it announced. */
  name: string | null
  ip: string
  mac: string
  /** Seconds since pi-hole last heard from it; null for a reservation never seen. */
  lastSeenAgo: number | null
  status: AgentStatus
}

export type MachinesData = {
  port: number
  /** How many devices were asked. */
  probed: number
  /** Devices that were on the table but too old to ask. */
  skipped: number
  machines: Machine[]
  /** Why the LAN list could not be read at all, when it could not. */
  error: string | null
}

async function probe(d: Device, port: number): Promise<Machine | null> {
  const r = await getJsonResult<unknown>(`http://${d.ip}:${port}/status`, {}, PROBE_MS)
  if (!r.ok) return null
  try {
    return {
      name: d.name,
      ip: d.ip,
      mac: d.mac,
      lastSeenAgo: d.lastSeenAgo,
      status: agentStatus(r.value),
    }
  } catch {
    // Something answered on the port with JSON that is not a status page.
    return null
  }
}

export async function loadMachines(ctx: Ctx): Promise<MachinesData> {
  const port = AGENT_PORT
  let devices: Device[]
  try {
    devices = await lanDevices(ctx)
  } catch (e) {
    return {
      port,
      probed: 0,
      skipped: 0,
      machines: [],
      error: e instanceof Error ? e.message : 'the LAN device list could not be read',
    }
  }
  const self = ctx.env('LAN_IP') ?? ''
  const candidates = devices.filter(
    (d) => d.ip !== '?' && d.ip !== self && d.lastSeenAgo !== null && d.lastSeenAgo < RECENT_SECS,
  )
  const found = await Promise.all(candidates.map((d) => probe(d, port)))
  const machines = found
    .filter((m): m is Machine => m !== null)
    .sort((a, b) =>
      (a.status.hostname || a.name || a.ip).localeCompare(b.status.hostname || b.name || b.ip),
    )
  return {
    port,
    probed: candidates.length,
    skipped: devices.length - candidates.length,
    machines,
    error: null,
  }
}
