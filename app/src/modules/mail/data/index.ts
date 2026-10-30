// The Email module's data half: one page, two subjects.
//
// The alert relay is the platform's (msmtp, every box has it), so it is read
// on every box; the reader is lib/dashboard/mail-relay.ts, shared with
// Monitoring › Alerts. Proton Mail Bridge is a stack a box may not run: its
// half is read while `proton-bridge` is on, and is null otherwise — the page
// then draws the relay alone.

import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { loadMailRelay, type MailRelay } from '../../../lib/dashboard/mail-relay'
import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { releases } from '../releases'
import { type BridgeReport, readBridge } from './bridge'

export type BridgeData = {
  report: BridgeReport
  gap: VersionGap
  /** Where `gap.installed` came from: Bridge itself while it reports, else the pinned build. */
  versionFrom: 'bridge' | 'pin'
}

export type OverviewData = { bridge: BridgeData | null; relay: MailRelay }

export type Tabs = { overview: OverviewData }
export type MailData = TabPayload<typeof manifest, Tabs>

async function loadBridge(ctx: Ctx): Promise<BridgeData> {
  const report = await readBridge(ctx)
  const reported = report.reporting ? (report.status?.version ?? '') : ''
  const versionFrom = reported === '' ? 'pin' : 'bridge'
  const running = reported === '' ? (ctx.env('PROTON_BRIDGE_VERSION') ?? null) : reported
  return { report, gap: await versionGap(releases['proton-bridge'].repo, running), versionFrom }
}

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  overview: async (ctx) => {
    const [bridge, relay] = await Promise.all([
      ctx.modules.enabled('proton-bridge') ? loadBridge(ctx) : Promise.resolve(null),
      loadMailRelay(ctx),
    ])
    return { bridge, relay }
  },
})
