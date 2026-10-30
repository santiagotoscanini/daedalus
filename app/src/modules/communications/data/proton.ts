import type { Ctx } from '../../../core/ctx'
import { type AppResources, containerResources } from '../../../lib/apps/metrics'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { releases } from '../releases'
import { type BridgeReport, readBridge } from './bridge'
import { type BridgeLogs, loadBridgeLogs } from './bridge-logs'

// Communications › the Proton Mail tab: Bridge as its supervisor reports it (the
// status file, re-read live by server/communications.ts), the container around it from
// Prometheus, and its own warnings from Loki.

/** The container the host's proton-bridge stack runs, and the name its metrics carry. */
const CONTAINER = 'proton-bridge'

export type ProtonData = {
  report: BridgeReport
  gap: VersionGap
  /** Where `gap.installed` came from: Bridge itself while it reports, else the pinned build. */
  versionFrom: 'bridge' | 'pin'
  resources: AppResources
  /** The last day of Bridge's warnings and errors. Null: Loki did not answer. */
  logs: BridgeLogs | null
}

export async function loadProton(ctx: Ctx): Promise<ProtonData> {
  const [report, resources, logs] = await Promise.all([
    readBridge(ctx),
    containerResources(ctx, CONTAINER),
    loadBridgeLogs(ctx),
  ])
  const reported = report.reporting ? (report.status?.version ?? '') : ''
  const versionFrom = reported === '' ? 'pin' : 'bridge'
  const running = reported === '' ? (ctx.env('PROTON_BRIDGE_VERSION') ?? null) : reported
  const gap = await versionGap(releases['proton-bridge'].repo, running)
  return { report, gap, versionFrom, resources, logs }
}
