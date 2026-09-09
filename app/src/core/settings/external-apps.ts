import { DEFAULT_EXTERNAL_APPS, type ExternalApp, isExternalAppList } from '../../lib/external-apps'
import { SETTING_KEYS } from '../../lib/repo/settings'
import type { Ctx } from '../ctx'

// The off-box project list, read from the preferences store with the
// hand-edited literal as the seed. Nothing on the box builds or serves these
// sites, so nix never consumes the list — which is exactly the kind of value
// that belongs in Postgres rather than the site repository (see the
// `settings` table comment in lib/schema.ts). Read-only until the settings
// page grows an editor for it; until then the seed is what renders, and a row
// written by hand under `apps.external` overrides it whole.

export async function listExternalApps(ctx: Ctx): Promise<ExternalApp[]> {
  try {
    return (
      (await ctx.store.read(SETTING_KEYS.externalApps, isExternalAppList)) ?? DEFAULT_EXTERNAL_APPS
    )
  } catch {
    // The app list must render with the database down; the seed is the
    // answer the box gave before the store existed.
    return DEFAULT_EXTERNAL_APPS
  }
}

export async function findExternalApp(ctx: Ctx, id: string): Promise<ExternalApp | null> {
  return (await listExternalApps(ctx)).find((e) => e.id === id) ?? null
}
