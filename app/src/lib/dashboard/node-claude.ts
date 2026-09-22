import {
  AGENT_PORT,
  type AgentStatus,
  agentStatus,
  type NodeClaude,
  nodeClaudeReport,
} from '../agent/status'
import { getJsonResult } from '../http'
import { getNode, type NodeRow, nodeToken } from '../repo/nodes'

// The Claude page for a machine that is not this box.
//
// Two reads of the agent's status page. `/status` is open to the LAN and
// carries a summary; `/claude` is the tray's full report — session names,
// working directories, ids, the environment id, the login's dates — and
// the agent answers it only to the node token the box minted at approval
// and hands down every hello answer (lib/repo/nodes.ts). The token never
// reaches a page: this loader runs on the server and sends it as a bearer.
// No snapshot, no Loki — the node's own log stays on the node.

/** A LAN machine that is up answers within the first step; one asleep does not answer at all. */
const PROBE_MS = [800, 1_500, 2_500]

export type NodeClaudeData = {
  node: NodeRow
  /** The status page, when it answered just now. */
  status: AgentStatus | null
  /** The full report, when the agent accepted the box's token and the tray is reporting. */
  report: NodeClaude | null
  /** Why the agent refused the report, when it did (an agent older than 0.6.0, no token yet). */
  reportError: string | null
  /** Why the status page did not answer, when it did not. */
  error: string | null
}

export async function loadNodeClaude(id: string): Promise<NodeClaudeData | null> {
  const node = await getNode(id)
  if (node === null) return null
  const none = { node, status: null, report: null, reportError: null }
  if (node.lanIp === null) return { ...none, error: 'the node has not reported an address' }
  const port = node.statusPort ?? AGENT_PORT
  const base = `http://${node.lanIp}:${String(port)}`
  const r = await getJsonResult<unknown>(`${base}/status`, {}, PROBE_MS)
  if (!r.ok) {
    const why =
      r.reason.error ?? (r.reason.status === null ? 'no answer' : `HTTP ${String(r.reason.status)}`)
    return { ...none, error: `${node.lanIp}:${String(port)} — ${why}` }
  }
  let status: AgentStatus
  try {
    status = agentStatus(r.value)
  } catch (e) {
    return { ...none, error: e instanceof Error ? e.message : 'not a status page' }
  }

  const token = await nodeToken(id)
  if (token === null) {
    return { ...none, status, error: null, reportError: 'no node token yet: approve the machine' }
  }
  const full = await getJsonResult<unknown>(
    `${base}/claude`,
    { headers: { authorization: `Bearer ${token}` } },
    PROBE_MS,
  )
  if (!full.ok) {
    const why =
      full.reason.status === 403
        ? 'the agent refused the box’s token (it may predate the token, or not have heard it yet)'
        : full.reason.status === 404
          ? 'the agent is older than 0.6.0 and has no report endpoint'
          : (full.reason.error ?? `HTTP ${String(full.reason.status)}`)
    return { ...none, status, error: null, reportError: why }
  }
  try {
    return { node, status, report: nodeClaudeReport(full.value), reportError: null, error: null }
  } catch (e) {
    return {
      ...none,
      status,
      error: null,
      reportError: e instanceof Error ? e.message : 'not a report',
    }
  }
}
