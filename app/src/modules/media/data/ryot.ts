import type { Ctx } from '../../../core/ctx'
import { EMPTY_GAP, type VersionGap, versionGap } from '../../../lib/dashboard/github'

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
 * Its MCP server is our own, built on the box from a clone that is not
 * published yet, so there is no release list to compare it with: the gap is
 * the version alone until the repository has releases.
 */
export type RyotData = {
  version: string | null
  gap: VersionGap
  mcp: { version: string | null; gap: VersionGap }
}

export async function loadRyot(ctx: Ctx): Promise<RyotData> {
  const version = ctx.env('RYOT_VERSION') || null
  const mcpVersion = ctx.env('RYOT_MCP_VERSION') || null
  return {
    version,
    gap: await versionGap('IgnisDa/ryot', version),
    mcp: { version: mcpVersion, gap: { ...EMPTY_GAP, installed: mcpVersion } },
  }
}
