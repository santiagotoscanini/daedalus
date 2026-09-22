import { AGENT_PORT, type AgentStatus, agentStatus } from '../agent/status'
import { getJsonResult } from '../http'
import { getNode, type NodeRow } from '../repo/nodes'

// The Claude page for a machine that is not this box.
//
// Everything the page shows comes from one place: the agent's status page
// on the node, which carries the tray's report of `claude remote-control`
// (agent/src/claude.rs). No snapshot, no Loki — the node's own log stays on
// the node, in its logs folder, and the Connection board the box's page
// has is not drawn here. The node row is what says where to ask, and what
// the box has decided about the machine.

/** A LAN machine that is up answers within the first step; one asleep does not answer at all. */
const PROBE_MS = [800, 1_500, 2_500]

export type NodeClaudeData = {
  node: NodeRow
  /** The status page, when it answered just now. */
  status: AgentStatus | null
  /** Why it did not, when it did not. */
  error: string | null
}

export async function loadNodeClaude(id: string): Promise<NodeClaudeData | null> {
  const node = await getNode(id)
  if (node === null) return null
  if (node.lanIp === null) {
    return { node, status: null, error: 'the node has not reported an address' }
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
    return { node, status: null, error: `${node.lanIp}:${String(port)} — ${why}` }
  }
  try {
    return { node, status: agentStatus(r.value), error: null }
  } catch (e) {
    return { node, status: null, error: e instanceof Error ? e.message : 'not a status page' }
  }
}
