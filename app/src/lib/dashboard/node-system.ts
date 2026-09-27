import { type ControllerClient, controller } from '../../host/controller/client'
import { readNode } from '../../host/controller/nodes'
import { promQuote, promSeries } from '../../host/prom'
import type { AgentStatus, NodeTelemetry } from '../agent/status'
import { getNode, type NodeRow } from '../repo/nodes'
import { type BoardReleases, boardReleases } from './board-releases'
import { type BrowserLatest, browserLatest } from './browser-releases'
import { type MacReleases, macosReleases } from './macos-releases'

// The System page for a machine that is not this box, the same tabs the
// box draws for itself (components/machine-system/): what the controller
// holds for the machine — its status document and the full telemetry
// document it pushed up its link (agent/src/telemetry.rs: drive serials,
// the heaviest processes, the services that are down, the OS's pending
// updates) — and the box's own Prometheus for the six-hour processor
// history the agent's `/metrics` has been feeding it.
//
// One read serves every tab. The tabs are a way of reading one document,
// not five requests. A machine that is not connected shows what the
// controller last heard from it, and nothing once the controller has
// restarted since.

export type NodeSystemData = {
  node: NodeRow
  status: AgentStatus | null
  /** Null before the machine's first sample reached the controller. */
  telemetry: NodeTelemetry | null
  /**
   * Whether `telemetry` is the full document. False when only the summary
   * `nodes.get` carries has arrived, and `detailError` says why.
   */
  full: boolean
  detailError: string | null
  /**
   * The maker's BIOS releases, read only for the Motherboard tab (it asks a
   * download host on the internet, which the other tabs have no use for).
   */
  releases: BoardReleases | null
  /** The vendors' current stable per installed browser, read only for the Chromium tab. */
  browserLatest: BrowserLatest[] | null
  /** What Apple has shipped past the running macOS, read only for the macOS tab. */
  macos: MacReleases | null
  /** Processor busy, six hours at two-minute steps, from the box's Prometheus. */
  cpuSpark: number[]
  error: string | null
}

export async function loadNodeSystem(
  id: string,
  opts: { board?: boolean; browsers?: boolean; macos?: boolean; client?: ControllerClient } = {},
): Promise<NodeSystemData | null> {
  const node = await getNode(id)
  if (node === null) return null
  const client = opts.client ?? controller()
  // The spark does not need the machine: it is what the box has scraped,
  // and a machine that is asleep still has a history.
  const [read, cpuSpark] = await Promise.all([
    readNode(client, id),
    promSeries(
      `daedalus_agent_cpu_usage_percent{host=${promQuote(node.hostname)}}`,
      6 * 60,
      120,
    ).catch(() => []),
  ])
  const none = {
    node,
    status: null,
    telemetry: null,
    full: false,
    detailError: null,
    releases: null,
    browserLatest: null,
    macos: null,
    cpuSpark,
  }
  const d = read.detail
  if (d === null) return { ...none, error: read.error }
  if (d.status === null) {
    return {
      ...none,
      error: d.connected ? 'connected, but no status has arrived yet' : 'not connected',
    }
  }
  const status = d.status

  let t = d.telemetry
  let full = false
  let detailError: string | null = null
  try {
    const answer = await client.nodesTelemetry(id)
    if (answer.telemetry !== null) {
      t = answer.telemetry
      full = true
    } else {
      detailError = 'the full document has not arrived yet'
    }
  } catch (e) {
    detailError = e instanceof Error ? e.message : String(e)
  }
  if (t === null) return { ...none, status, detailError, error: null }

  const releases =
    opts.board === true
      ? await boardReleases({
          vendor: t.machine.boardManufacturer ?? t.machine.manufacturer,
          product: t.machine.boardProduct ?? t.machine.model,
          biosVersion: t.machine.biosVersion,
          biosDate: t.machine.biosDate,
        })
      : null
  const browsers =
    opts.browsers === true
      ? await browserLatest(
          t.browsers.map((b) => b.kind),
          node.os,
          node.arch,
        )
      : null
  // The Mac's own version is on the status document, so Apple's list does
  // not need the full one either.
  const macos =
    opts.macos === true && node.os === 'macos'
      ? await macosReleases(status.osVersion, t.machine.target)
      : null
  return {
    ...none,
    status,
    telemetry: t,
    full,
    detailError,
    releases,
    browserLatest: browsers,
    macos,
    error: null,
  }
}
