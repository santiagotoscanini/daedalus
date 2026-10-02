import { cmp, releases, versionGap } from '../../lib/dashboard/github'
import {
  LEMONADE_REPO,
  type LemonadeTarget,
  pickLemonadeAsset,
} from '../../lib/providers/lemonade-release'
import { CALENDAR_TAG } from '../../lib/release-tags'
import type { Result } from '../../lib/result'
import type { ProviderPin } from '../controller/generated'

// Lemonade's releases, read once from GitHub's release API through the same
// stale-serving cache every changelog on the pages uses (lib/dashboard/
// github.ts: fifteen minutes, the installation token's budget), so neither the
// rail's dot nor a page load asks GitHub again on its own.

/** The newest release, and whether `installed` is behind it; nulls when either is unknown. */
export async function lemonadeUpdate(
  installed: string | null,
): Promise<{ latest: string | null; behind: number }> {
  const gap = await versionGap(LEMONADE_REPO, installed, { tag: CALENDAR_TAG })
  return { latest: gap.latest, behind: gap.behind.length }
}

/** What has been published between `installed` and the newest, with notes: Providers' changelog. */
export function lemonadeNotes(installed: string | null) {
  return versionGap(LEMONADE_REPO, installed, { tag: CALENDAR_TAG })
}

/**
 * The pin for this machine: the newest stable release, or the one `version`
 * names (`v2026.40.0` or `2026.40.0`), with the asset for its OS — or why
 * there is none.
 */
export async function resolveLemonadeRelease(
  target: LemonadeTarget,
  version?: string,
): Promise<Result<ProviderPin>> {
  const list = await releases(LEMONADE_REPO)
  if (list === null) return { ok: false, reason: 'GitHub did not answer for Lemonade’s releases' }
  const stable = list
    .filter((r) => r.draft !== true && r.prerelease !== true)
    .map((r) => ({ r, v: CALENDAR_TAG.exec(r.tag_name ?? '')?.[1] }))
    .filter((x): x is { r: (typeof list)[number]; v: string } => x.v !== undefined)
    .sort((a, b) => cmp(b.v, a.v))
  const wanted = version?.trim().replace(/^v/i, '')
  const hit = wanted === undefined ? stable[0] : stable.find((x) => x.v === wanted)
  if (hit === undefined) {
    return {
      ok: false,
      reason:
        wanted === undefined
          ? 'Lemonade has published no release'
          : `Lemonade has published no release ${wanted}`,
    }
  }
  return pickLemonadeAsset(
    {
      tag: hit.r.tag_name ?? '',
      assets: (hit.r.assets ?? []).map((a) => ({
        name: a.name ?? '',
        size: a.size ?? 0,
        digest: a.digest ?? null,
        url: a.browser_download_url ?? '',
      })),
    },
    target,
  )
}
