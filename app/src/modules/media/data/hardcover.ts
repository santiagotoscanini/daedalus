import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'

/* ── Hardcover ────────────────────────────────────────────────────────── */

/**
 * The reading log: Hardcover itself is not on the box, so this is its MCP
 * server — two packages in one locally built image, the PyPI server and the
 * supergateway that fronts it. nix pins both versions and hands them in
 * through fleet.dashboard; each falls behind on its own, so each has its own
 * gap (the Yazio shape on Health › Nutrition).
 */
export type HardcoverData = {
  version: string | null
  gap: VersionGap
  supergateway: { version: string | null; gap: VersionGap }
}

export async function loadHardcover(ctx: Ctx): Promise<HardcoverData> {
  const version = ctx.env('HARDCOVER_MCP_VERSION') || null
  const supergateway = ctx.env('HARDCOVER_SUPERGATEWAY_VERSION') || null
  const [gap, sgGap] = await Promise.all([
    versionGap('kristianedlund/hardcover-mcp', version),
    versionGap('supercorp-ai/supergateway', supergateway),
  ])
  return { version, gap, supergateway: { version: supergateway, gap: sgGap } }
}
