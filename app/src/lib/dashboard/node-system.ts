import { promQuote, promSeries } from '../../host/prom'
import {
  AGENT_PORT,
  type AgentStatus,
  agentStatus,
  type NodeTelemetry,
  nodeTelemetry,
  nodeTelemetryFull,
} from '../agent/status'
import { getJsonResult } from '../http'
import { getNode, type NodeRow, nodeToken } from '../repo/nodes'

// The System page for a machine that is not this box, the same tabs the
// box draws for itself (components/machine-system/): one read of the
// agent's open status page for the agent's own state, one token-gated
// read of `/telemetry` for the full document (agent/src/telemetry.rs —
// drive serials, the heaviest processes, the services that are down, the
// OS's pending updates; the open page carries the machine without the
// person), and the box's own Prometheus for the six-hour processor
// history the agent's `/metrics` has been feeding it.
//
// One fetch serves every tab. The tabs are a way of reading one document,
// not five requests, and a machine that answers once has answered for all
// of them.

const PROBE_MS = [800, 1_500, 2_500]

export type NodeSystemData = {
  node: NodeRow
  status: AgentStatus | null
  /** Null when the page answered but the agent predates telemetry. */
  telemetry: NodeTelemetry | null
  /**
   * Whether `telemetry` is the full document. False when it is the open
   * page's block — no token yet, or an agent older than 0.8.0 — and
   * `detailError` says which.
   */
  full: boolean
  detailError: string | null
  /** Processor busy, six hours at two-minute steps, from the box's Prometheus. */
  cpuSpark: number[]
  error: string | null
}

export async function loadNodeSystem(id: string): Promise<NodeSystemData | null> {
  const node = await getNode(id)
  if (node === null) return null
  const none = {
    node,
    status: null,
    telemetry: null,
    full: false,
    detailError: null,
    cpuSpark: [] as number[],
  }
  if (node.lanIp === null) {
    return { ...none, error: 'the node has not reported an address' }
  }
  const port = node.statusPort ?? AGENT_PORT
  const base = `http://${node.lanIp}:${String(port)}`
  // The spark does not need the machine to answer: it is what the box has
  // scraped, and a machine that is asleep still has a history.
  const [r, cpuSpark, token] = await Promise.all([
    getJsonResult<unknown>(`${base}/status`, {}, PROBE_MS),
    promSeries(
      `daedalus_agent_cpu_usage_percent{host=${promQuote(node.hostname)}}`,
      6 * 60,
      120,
    ).catch(() => []),
    nodeToken(id),
  ])
  if (!r.ok) {
    const why =
      r.reason.error ?? (r.reason.status === null ? 'no answer' : `HTTP ${String(r.reason.status)}`)
    return { ...none, cpuSpark, error: `${node.lanIp}:${String(port)} — ${why}` }
  }
  let status: AgentStatus
  let open: NodeTelemetry | null
  try {
    status = agentStatus(r.value)
    open = nodeTelemetry(r.value)
  } catch (e) {
    return { ...none, cpuSpark, error: e instanceof Error ? e.message : 'not a status page' }
  }
  if (open === null) {
    return { ...none, status, cpuSpark, error: null }
  }
  if (token === null) {
    return {
      ...none,
      status,
      telemetry: open,
      cpuSpark,
      detailError: 'no node token yet: approve the machine',
      error: null,
    }
  }
  const fullDoc = await getJsonResult<unknown>(
    `${base}/telemetry`,
    { headers: { authorization: `Bearer ${token}` } },
    PROBE_MS,
  )
  if (!fullDoc.ok) {
    const why =
      fullDoc.reason.status === 403
        ? 'the agent refused the box’s token (it may not have heard it yet)'
        : fullDoc.reason.status === 404
          ? 'the agent is older than 0.8.0: drives, processes, services and updates arrive with it'
          : (fullDoc.reason.error ?? `HTTP ${String(fullDoc.reason.status)}`)
    return { ...none, status, telemetry: open, cpuSpark, detailError: why, error: null }
  }
  try {
    const t = nodeTelemetryFull(fullDoc.value)
    return t === null
      ? { ...none, status, telemetry: open, cpuSpark, detailError: 'empty answer', error: null }
      : { ...none, status, telemetry: t, full: true, cpuSpark, error: null }
  } catch (e) {
    return {
      ...none,
      status,
      telemetry: open,
      cpuSpark,
      detailError: e instanceof Error ? e.message : 'not a telemetry document',
      error: null,
    }
  }
}
