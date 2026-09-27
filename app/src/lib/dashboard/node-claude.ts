import { type ControllerClient, controller } from '../../host/controller/client'
import { readNode } from '../../host/controller/nodes'
import type { AgentStatus, NodeClaude } from '../agent/status'
import { getNode, type NodeRow } from '../repo/nodes'

// The Claude tab (System › Claude) for a machine that is not this box: its
// status document and its session's full Claude report — session names,
// working directories, ids, the environment id, the login's dates — as the
// machine pushed them up its link and the controller holds them. No
// snapshot, no Loki — the machine's own log stays on the machine.

export type NodeClaudeData = {
  node: NodeRow
  /** The status document, when the controller holds one. */
  status: AgentStatus | null
  /** The full report, when the machine's session has sent one. */
  report: NodeClaude | null
  /** Why there is no report, when the controller could not say. */
  reportError: string | null
  /** Why there is no status document, when there is none. */
  error: string | null
}

export async function loadNodeClaude(
  id: string,
  client: ControllerClient = controller(),
): Promise<NodeClaudeData | null> {
  const node = await getNode(id)
  if (node === null) return null
  const none = { node, status: null, report: null, reportError: null }
  const read = await readNode(client, id)
  const d = read.detail
  if (d === null) return { ...none, error: read.error }
  if (d.status === null) {
    return {
      ...none,
      error: d.connected ? 'connected, but no status has arrived yet' : 'not connected',
    }
  }
  try {
    const answer = await client.nodesClaude(id)
    return { node, status: d.status, report: answer.report, reportError: null, error: null }
  } catch (e) {
    return {
      ...none,
      status: d.status,
      error: null,
      reportError: e instanceof Error ? e.message : String(e),
    }
  }
}
