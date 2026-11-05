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
 */
export type RyotData = {
  version: string | null
  gap: VersionGap
}

export async function loadRyot(ctx: Ctx): Promise<RyotData> {
  const version = ctx.env('RYOT_VERSION') || null
  return { version, gap: await versionGap('IgnisDa/ryot', version) }
}
