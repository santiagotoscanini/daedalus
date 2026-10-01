import type { Ctx } from '../../core/ctx'
import type { ProviderReport, StatusDocument, Telemetry } from '../../host/controller/generated'
import { readNode } from '../../host/controller/nodes'
import { getNode, type NodeRow } from '../repo/nodes'
import { type BoardReleases, boardReleases } from './board-releases'
import { type BrowserLatest, browserLatest } from './browser-releases'
import { type MacReleases, macosReleases } from './macos-releases'

// The System page for a machine that is not this box, the same tabs the
// box draws for itself (modules/system/view/node/): what the controller
// holds for the machine — its status document and the full telemetry
// document it pushed up its link (agent/src/telemetry.rs: drive serials,
// the heaviest processes, the services that are down, the OS's pending
// updates) — and the box's own Prometheus for the six-hour processor
// history it has scraped from the controller's `/nodes/metrics`, which
// serves every connected machine's telemetry labelled by node id.
//
// One read serves every tab. The tabs are a way of reading one document,
// not five requests. A machine that is not connected shows what the
// controller last heard from it, and nothing once the controller has
// restarted since.

export type NodeSystemData = {
  node: NodeRow
  status: StatusDocument | null
  /** The full document; null before the machine's first sample reached the controller. */
  telemetry: Telemetry | null
  /**
   * What the machine's agent read from its providers (agent/src/providers/),
   * as it last reported them; null until it has.
   */
  providers: ProviderReport[] | null
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
  ctx: Pick<Ctx, 'controller' | 'prom'>,
  id: string,
  opts: { board?: boolean; browsers?: boolean; macos?: boolean } = {},
): Promise<NodeSystemData | null> {
  // One read: the machine, its status, its full telemetry and its providers.
  // The spark does not need the machine: it is what the box has scraped,
  // and a machine that is asleep still has a history.
  const [read, cpuSpark] = await Promise.all([
    readNode(ctx, id, true),
    ctx.prom
      .series(`daedalus_agent_cpu_usage_percent{node=${ctx.prom.quote(id)}}`, 6 * 60, 120)
      .catch(() => []),
  ])
  const node = await getNode(id, read)
  if (node === null) return null
  const none = {
    node,
    status: null,
    telemetry: null,
    providers: null,
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
  const { status, telemetry: t, providers } = d
  if (t === null) {
    return { ...none, status, providers, error: null }
  }

  const releases =
    opts.board === true
      ? await boardReleases({
          vendor: t.machine.board_manufacturer ?? t.machine.manufacturer,
          product: t.machine.board_product ?? t.machine.model,
          biosVersion: t.machine.bios_version,
          biosDate: t.machine.bios_date,
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
      ? await macosReleases(status.os_version, t.machine.target)
      : null
  return {
    ...none,
    status,
    telemetry: t,
    providers,
    releases,
    browserLatest: browsers,
    macos,
    error: null,
  }
}
