import { eq } from 'drizzle-orm'
import { db } from '../db'
import { settings } from '../schema'

// The preferences store. One row per key; see the `settings` table comment in
// schema.ts for what does and does not belong in it.

/**
 * Read one preference, narrowed by a caller-supplied guard.
 *
 * The guard is not optional and not decoration. The value is `jsonb`, so
 * what comes back is whatever shape was written — by an older version of
 * this app, or by a preference that has since changed shape. Returning
 * `undefined` for anything that no longer matches means a stale row
 * degrades to the default instead of reaching a component as the wrong
 * type.
 */
export async function readSetting<T>(
  key: string,
  guard: (v: unknown) => v is T,
): Promise<T | undefined> {
  const rows = await db.select().from(settings).where(eq(settings.key, key)).limit(1)
  const value = rows[0]?.value
  return guard(value) ? value : undefined
}

export async function writeSetting(key: string, value: unknown): Promise<void> {
  await db
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    })
}

/**
 * Forget a preference. The column is `jsonb NOT NULL`, so "no value" is the
 * absence of the row, not a null in it — `writeSetting(key, null)` is a
 * constraint violation, and a reader's guard would have treated a JSON null
 * as the default anyway. Deleting a key that is not there is a no-op.
 */
export async function deleteSetting(key: string): Promise<void> {
  await db.delete(settings).where(eq(settings.key, key))
}

/** The keys this app uses, so a typo is a compile error rather than a default. */
export const SETTING_KEYS = {
  theme: 'ui.theme',
  /** The off-box project list (lib/external-apps.ts is the seed). */
  externalApps: 'apps.external',
  /** Whether the host commits what it writes under site/ (it always stages). */
  siteCommit: 'site.commit',
  /** The operator's desired site.json — the editing surface for site values (core/site). */
  siteDraft: 'site.draft',
} as const
