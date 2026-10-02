import type { Ctx } from '../../../core/ctx'
// The Health module's data half: a person's record and the services that feed
// it, a tab per subject. The tab order and the rule on it are ../manifest.ts's;
// Pantry's loader is ./pantry.ts.

import {
  type CommitGap,
  commitsSince,
  type VersionGap,
  versionGap,
} from '../../../lib/dashboard/github'
import { imageTag } from '../../../lib/dashboard/images'
import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { releases } from '../releases'
import { loadPantry, type PantryData } from './pantry'

export type Tabs = {
  record: RecordData
  pantry: PantryData
  nutrition: NutritionData
  training: TrainingData
}
export type HealthData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  record: loadRecord,
  pantry: loadPantry,
  nutrition: loadNutrition,
  training: loadTraining,
})

/* ── Record: getbased and its sync relay ──────────────────────────────── */

/**
 * getbased keeps every profile in the browser that opened it, so the server
 * has nothing to report about the data itself: no counts, no sizes, no last
 * import. What this tab can say is where the two halves are, what each is
 * built from, and how far upstream has moved since.
 *
 * Both images are built on the box from pinned sources. The app follows
 * upstream's main branch by commit (its release tags lag the fixes a local
 * model needs), so its distance is commits; the relay cuts releases.
 */
type RecordData = {
  /** The app, as a browser opens it. */
  url: string
  /** What a device's sync setting must name: the relay's hostname as `wss://`. */
  relayUrl: string
  build: CommitGap
  relay: { version: string | null; gap: VersionGap }
}

async function loadRecord(ctx: Ctx): Promise<RecordData> {
  const relayVersion = await imageTag('getbased-relay')
  const [build, relayGap] = await Promise.all([
    commitsSince('elkimek/get-based', ctx.env('GETBASED_REV') || null, 'main'),
    versionGap('elkimek/getbased-relay', relayVersion),
  ])
  return {
    url: ctx.hosts.base('getbased'),
    relayUrl: ctx.hosts.base('getbased-relay').replace(/^https:/, 'wss:'),
    build,
    relay: { version: relayVersion, gap: relayGap },
  }
}

/* ── Nutrition: the Yazio MCP server ─────────────────────────────────── */

/**
 * Two npm packages in one locally built image — the stdio server and the
 * supergateway that fronts it — and nix pins both versions, handed in through
 * fleet.dashboard. Each falls behind on its own, so each gets its own gap.
 */
type NutritionData = {
  version: string | null
  gap: VersionGap
  supergateway: { version: string | null; gap: VersionGap }
}

async function loadNutrition(ctx: Ctx): Promise<NutritionData> {
  const version = ctx.env('YAZIO_MCP_VERSION') || null
  const supergateway = ctx.env('SUPERGATEWAY_VERSION') || null
  const [gap, sgGap] = await Promise.all([
    versionGap('fliptheweb/yazio-mcp', version),
    versionGap('supercorp-ai/supergateway', supergateway),
  ])
  return { version, gap, supergateway: { version: supergateway, gap: sgGap } }
}

/* ── Training: the Hevy MCP server ───────────────────────────────────── */

type TrainingData = { version: string | null; gap: VersionGap }

async function loadTraining(): Promise<TrainingData> {
  const version = await imageTag('mcp-hevy')
  return {
    version,
    gap: await versionGap('chrisdoc/hevy-mcp', version, releases['mcp-hevy']?.opts),
  }
}
