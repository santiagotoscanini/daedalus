import {
  AGENT_PORT,
  type AgentStatus,
  agentStatus,
  type NodeTelemetry,
  nodeTelemetry,
} from '../agent/status'
import { getJsonResult } from '../http'
import { getNode, type NodeRow } from '../repo/nodes'

// The System page for a machine that is not this box: one read of the
// agent's open status page, which carries the agent's own state and, from
// 0.7.0, the telemetry block (agent/src/telemetry.rs). Nothing here needs
// the node token — a machine's make, firmware and load are what the LAN
// may already see.

const PROBE_MS = [800, 1_500, 2_500]

export type NodeSystemData = {
  node: NodeRow
  status: AgentStatus | null
  /** Null when the page answered but the agent predates telemetry. */
  telemetry: NodeTelemetry | null
  error: string | null
}

export async function loadNodeSystem(id: string): Promise<NodeSystemData | null> {
  const node = await getNode(id)
  if (node === null) return null
  if (node.lanIp === null) {
    return { node, status: null, telemetry: null, error: 'the node has not reported an address' }
  }
  const port = node.statusPort ?? AGENT_PORT
  const r = await getJsonResult<unknown>(
    `http://${node.lanIp}:${String(port)}/status`,
    {},
    PROBE_MS,
  )
  if (!r.ok) {
    const why =
      r.reason.error ?? (r.reason.status === null ? 'no answer' : `HTTP ${String(r.reason.status)}`)
    return { node, status: null, telemetry: null, error: `${node.lanIp}:${String(port)} — ${why}` }
  }
  try {
    return {
      node,
      status: agentStatus(r.value),
      telemetry: nodeTelemetry(r.value),
      error: null,
    }
  } catch (e) {
    return {
      node,
      status: null,
      telemetry: null,
      error: e instanceof Error ? e.message : 'not a status page',
    }
  }
}
