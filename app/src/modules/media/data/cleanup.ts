import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import {
  type ImageFreshness,
  imageFreshness,
  imageTag,
  imageVersion,
  type RunningVersion,
} from '../../../lib/dashboard/images'
import { CLEANUP_DAYS } from './shared'

/* ── Cleanup ──────────────────────────────────────────────────────────── */

/**
 * The two services that act ON the library rather than filling it.
 *
 * They share a tab because they share a failure mode: both do their work on a
 * timer, neither has a UI you would open unprompted, and the only evidence
 * either is alive is a log line. Neither publishes the numbers this tab shows,
 * so they are counted out of Loki — which is why the panel says so.
 */
export type CleanupData = {
  cleanuparr: {
    version: string | null
    gap: VersionGap
    removed: number | null
    blocked: number | null
    searches: number | null
  }
  janitorr: {
    /** From the image label — its pin is the channel `jvm-stable`. */
    running: RunningVersion
    gap: VersionGap
    /** Whether the digest pin still matches the moving `jvm-stable` tag. */
    freshness: ImageFreshness | null
    /** Dry-run: what it WOULD have deleted in the window. */
    wouldDelete: number | null
    /**
     * The cleanups that report their own state, and whether each is armed.
     *
     * Not every cleanup Janitorr has — see `janitorrSchedules` — because only
     * some of them say so, and a list presented as complete would be a claim
     * this box cannot support.
     */
    schedules: { name: string; enabled: boolean }[]
  }
  /** The window the Loki counts are over. */
  days: number
}

export async function loadCleanup(ctx: Ctx): Promise<CleanupData> {
  const window = `${String(CLEANUP_DAYS)}d`
  const over = (container: string, needle: string) =>
    ctx.loki.scalar(
      `sum(count_over_time({container="${container}"} |= \`${needle}\` [${window}])) or vector(0)`,
    )

  // Cleanuparr's tag carries a real version and wins. Its image LABEL says
  // `24.04`, inherited from the Ubuntu base — the exact case that makes the
  // label a fallback rather than the primary. See lib/dashboard/images.ts.
  const cleanuparrVersion = await imageTag('cleanuparr')

  const [removed, blocked, searches, wouldDelete, janitorr, freshness] = await Promise.all([
    over('cleanuparr', 'Removing item with max strikes'),
    over('cleanuparr', 'blocked item keeps coming back'),
    over('cleanuparr', 'Replacement search triggered'),
    over('janitorr', 'Deleting'),
    // Pinned to the channel `jvm-stable`, so the version comes off the image's
    // own OCI label. Not Janitorr's startup banner in Loki: that only exists
    // while the container restarted inside the 30-day retention window, and
    // the version silently became "unknown" past it.
    imageVersion('janitorr'),
    // And whether that channel has moved on from the pin — the label says
    // what the frozen artefact is, the registry says whether it is still what
    // `jvm-stable` serves.
    imageFreshness('janitorr'),
  ])

  const schedules = await janitorrSchedules(ctx)

  const [cleanuparrGap, janitorrGap] = await Promise.all([
    versionGap('Cleanuparr/Cleanuparr', cleanuparrVersion),
    versionGap('Schaka/janitorr', janitorr.version),
  ])

  return {
    cleanuparr: { version: cleanuparrVersion, gap: cleanuparrGap, removed, blocked, searches },
    janitorr: { running: janitorr, gap: janitorrGap, freshness, wouldDelete, schedules },
    days: CLEANUP_DAYS,
  }
}

/**
 * The Janitorr cleanups that ANNOUNCE themselves, and whether each is armed.
 *
 * Read from the log because there is nowhere else: Janitorr exposes no API and
 * its configuration lives in a file inside the container. Two of its schedules
 * state their own status every hour when they fire, which a one-day window
 * catches many times over.
 *
 * Deliberately not a claim about every cleanup Janitorr has. Its media-based
 * schedule says nothing at all on this box — enabled or not — so a list
 * presented as complete would report "everything is off" while that one was
 * quietly deleting. The `wouldDelete` count beside this is what covers that
 * case: it counts decisions, whichever schedule reached them.
 */
async function janitorrSchedules(ctx: Ctx): Promise<CleanupData['janitorr']['schedules']> {
  const kinds = [
    { name: 'Tag', match: 'Tag based cleanup' },
    { name: 'Episode', match: 'Episode based cleanup' },
  ]
  const seen = await Promise.all(
    kinds.map(async (k) => {
      const line = await ctx.loki.latest(`{container="janitorr"} |= \`${k.match}\``, 24 * 60)
      // No line in the last day drops the schedule from the list rather than
      // guessing its state either way.
      return line === null ? null : { name: k.name, enabled: !line.includes('disabled') }
    }),
  )
  return seen.filter((s): s is NonNullable<typeof s> => s !== null)
}
