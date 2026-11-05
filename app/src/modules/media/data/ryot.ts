import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'

/* ── Ryot ─────────────────────────────────────────────────────────────── */

/**
 * The watch log: what was seen, played and thought of it. The version is the
 * pin's tag, handed in by nix through fleet.dashboard, because Ryot's API sits
 * behind the Pocket ID gate and this page reads none of it.
 *
 * Ryot tags patch releases (10.5.x, the security fixes) without publishing a
 * GitHub Release for them, so the running version can be newer than the
 * newest release here, with no notes of its own.
 *
 * Its MCP server is our own repository, built on the box from the flake input
 * of the same name; its Updates row (fleet.manualPins) names the same.
 */
export type RyotData = {
  version: string | null
  gap: VersionGap
  mcp: { version: string | null; gap: VersionGap }
}

export async function loadRyot(ctx: Ctx): Promise<RyotData> {
  const version = ctx.env('RYOT_VERSION') || null
  const mcpVersion = ctx.env('RYOT_MCP_VERSION') || null
  const [gap, mcpGap] = await Promise.all([
    versionGap('IgnisDa/ryot', version),
    versionGap('santiagotoscanini/ryot-mcp', mcpVersion),
  ])
  return { version, gap, mcp: { version: mcpVersion, gap: mcpGap } }
}
