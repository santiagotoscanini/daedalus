import { lokiLatest, lokiScalar } from '../../../loki'
import { type VersionGap, versionGap } from '../../github'
import {
  type ImageFreshness,
  imageFreshness,
  imageTag,
  imageVersion,
  type RunningVersion,
} from '../../images'
import { CLEANUP_DAYS } from './shared'

/* ── Cleanup ──────────────────────────────────────────────────────────── */

/**
 * The three services that act ON the library rather than filling it.
 *
 * They share a tab because they share a failure mode: all three do their work
 * on a timer, none of them has a UI you would open unprompted, and the only
 * evidence any of them is alive is a log line. Two publish no numbers at all,
 * so the counts here are counted out of Loki — which is why the panel says so.
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
  /** The window both counts are over. */
  days: number
}

export async function loadCleanup(): Promise<CleanupData> {
  const window = `${String(CLEANUP_DAYS)}d`
  const over = (container: string, needle: string) =>
    lokiScalar(
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
    // own OCI label. It used to be scraped out of Janitorr's startup banner in
    // Loki, which worked only while the container had restarted inside the
    // retention window; past 30 days Loki refuses the range outright and the
    // version silently became "unknown". The label has no such expiry.
    imageVersion('janitorr'),
    // And whether that channel has moved on from the pin — the label says
    // what the frozen artefact is, the registry says whether it is still what
    // `jvm-stable` serves.
    imageFreshness('janitorr'),
  ])

  const schedules = await janitorrSchedules()

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
async function janitorrSchedules(): Promise<CleanupData['janitorr']['schedules']> {
  const kinds = [
    { name: 'Tag', match: 'Tag based cleanup' },
    { name: 'Episode', match: 'Episode based cleanup' },
  ]
  const seen = await Promise.all(
    kinds.map(async (k) => {
      const line = await lokiLatest(`{container="janitorr"} |= \`${k.match}\``, 24 * 60)
      // Absent from the log is not "enabled" — it is "we have not seen it say
      // either", which lands as disabled=false only if a line exists.
      return line === null ? null : { name: k.name, enabled: !line.includes('disabled') }
    }),
  )
  return seen.filter((s): s is NonNullable<typeof s> => s !== null)
}
