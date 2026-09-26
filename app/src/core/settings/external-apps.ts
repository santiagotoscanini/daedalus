import {
  type ExternalApp,
  type ExternalAppInput,
  externalAppError,
  externalAppFrom,
  isExternalAppList,
} from '../../lib/external-apps'
import { listApps } from '../../lib/repo/apps'
import { SETTING_KEYS } from '../../lib/repo/settings'
import type { Result } from '../../lib/result'
import type { Ctx } from '../ctx'

// The off-box project list, in the preferences store and nowhere else.
//
// Nothing on the box builds or serves these sites, so nix never consumes the
// list — which is exactly the kind of value that belongs in Postgres rather
// than the site repository (see the `settings` table comment in
// host/schema.ts). And it is the operator's data, not the app's: the source
// carries no seed, a fresh box lists nothing until a row is added on
// Settings › Projects, and the list is written whole on every change — a few
// rows, edited by one person, are not worth a table.

export async function listExternalApps(ctx: Ctx): Promise<ExternalApp[]> {
  try {
    return (await ctx.store.read(SETTING_KEYS.externalApps, isExternalAppList)) ?? []
  } catch {
    // The app list must render with the database down; without the store
    // there are simply no off-box rows to show.
    return []
  }
}

export async function findExternalApp(ctx: Ctx, id: string): Promise<ExternalApp | null> {
  return (await listExternalApps(ctx)).find((e) => e.id === id) ?? null
}

/**
 * Add a row. Refused, as an answer rather than a throw, for the same reasons
 * the form shows in red — plus the one only the server can check: an id that
 * would collide with a registry app's name, which /api/app-icon resolves
 * first (lib/external-apps.ts `ExternalApp.id`).
 */
export async function addExternalApp(
  ctx: Ctx,
  input: ExternalAppInput,
): Promise<Result<ExternalApp>> {
  const [rows, apps] = await Promise.all([listExternalApps(ctx), listApps()])
  const taken = [...rows.map((r) => r.id), ...apps.map((a) => a.name)]
  const reason = externalAppError(input, taken)
  if (reason !== null) return { ok: false, reason }
  const row = externalAppFrom(input)
  await ctx.store.write(SETTING_KEYS.externalApps, [...rows, row])
  return { ok: true, value: row }
}

/** Drop a row by id. False when there was no such row, which is not an error. */
export async function removeExternalApp(ctx: Ctx, id: string): Promise<boolean> {
  const rows = await listExternalApps(ctx)
  const kept = rows.filter((r) => r.id !== id)
  if (kept.length === rows.length) return false
  await ctx.store.write(SETTING_KEYS.externalApps, kept)
  return true
}
