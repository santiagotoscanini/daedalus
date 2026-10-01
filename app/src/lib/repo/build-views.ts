import { and, asc, desc, eq, gte, inArray, isNotNull, or } from 'drizzle-orm'
import { db } from '../../host/db'
import { apps, builds, deployments } from '../../host/schema'
import { detectionFromStatus } from '../build-detect'
import { type BuildSummary, type LiveBuild, summarizeBuild } from '../build-display'
import type { BuildLane } from '../build-queue'
import type { BuildStatRow } from '../build-stats'
import { ACTIVE_BUILD_STATES, type BuildState } from '../builds'
import { BUILD_LIST_COLUMNS, getBuild, latestSucceeded, listBuilds, toBuildRow } from './builds'
import { sha256Digest } from './deployments'

// The reads the build UI needs that lib/repo/builds.ts (the queue's own
// repository) does not have.

/** The builds board's rows, newest first. */
export async function recentBuilds(appId: string, limit = 10): Promise<BuildSummary[]> {
  return (await listBuilds(appId, limit)).map((r) => summarizeBuild(toBuildRow(r)))
}

/** The overview's detection line: the last successful main-lane build, or null. */
export async function overviewBuild(appId: string) {
  const latest = await latestSucceeded(appId)
  if (latest === undefined) return null
  // The list read carries no detection or warnings: the one build this line
  // describes is read whole.
  const row = toBuildRow((await getBuild(latest.id)) ?? latest)
  return {
    summary: summarizeBuild(row),
    detection: detectionFromStatus(row.detected),
    // A row nobody computed warnings for counts as none here: the overview's
    // one line has no room to explain the difference, and the build page does.
    warningCount: row.warnings?.length ?? 0,
  }
}

/** A build of this sha that is queued or running in the lane, if any. */
export async function openBuildOf(
  appId: string,
  sha: string,
  lane: BuildLane = 'main',
): Promise<{ id: string; state: BuildState } | undefined> {
  const [row] = await db
    .select({ id: builds.id, state: builds.state })
    .from(builds)
    .where(
      and(
        eq(builds.appId, appId),
        eq(builds.lane, lane),
        eq(builds.sha, sha),
        inArray(builds.state, ['queued', ...ACTIVE_BUILD_STATES]),
      ),
    )
    .orderBy(desc(builds.createdAt))
    .limit(1)
  return row
}

/** The newest deploy that landed this digest (stored as `sha256:<hex>`, lib/repo/deployments.ts). */
export async function deploymentOfDigest(appId: string, digest: string) {
  const [row] = await db
    .select({
      result: deployments.result,
      startedAt: deployments.startedAt,
      httpCode: deployments.httpCode,
    })
    .from(deployments)
    .where(and(eq(deployments.appId, appId), eq(deployments.digest, sha256Digest(digest))))
    .orderBy(desc(deployments.startedAt))
    .limit(1)
  return row
}

// ── Apps › Builder ───────────────────────────────────────────────────────

/**
 * Every queued and running build, oldest first, with its stage timings — the
 * Builder page's "Now" board, re-read every few seconds while it is open.
 */
export async function builderNow(): Promise<LiveBuild[]> {
  const rows = await db
    .select({ ...BUILD_LIST_COLUMNS, app: apps.name, timings: builds.timings })
    .from(builds)
    .innerJoin(apps, eq(apps.id, builds.appId))
    .where(inArray(builds.state, ['queued', ...ACTIVE_BUILD_STATES]))
    .orderBy(asc(builds.createdAt))
  return rows.map((r) => ({
    ...summarizeBuild(toBuildRow(r)),
    app: r.app,
    timings: r.timings ?? {},
  }))
}

/**
 * Builds asked for since `since`, newest first, light: what lib/build-stats.ts
 * aggregates. Timings ride along (a handful of numbers per row); the heavy
 * jsonb columns do not.
 */
export async function buildsSince(since: Date, limit = 500): Promise<BuildStatRow[]> {
  const rows = await db
    .select({
      id: builds.id,
      app: apps.name,
      sha: builds.sha,
      state: builds.state,
      publish: builds.publish,
      phase: builds.phase,
      error: builds.error,
      timings: builds.timings,
      createdAt: builds.createdAt,
      startedAt: builds.startedAt,
      updatedAt: builds.updatedAt,
    })
    .from(builds)
    .innerJoin(apps, eq(apps.id, builds.appId))
    .where(gte(builds.createdAt, since))
    .orderBy(desc(builds.createdAt))
    .limit(limit)
  return rows.map((r) => ({
    ...r,
    phase: r.phase ?? '',
    timings: r.timings ?? {},
    createdAt: r.createdAt.toISOString(),
    startedAt: r.startedAt === null ? null : r.startedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }))
}

/** A build that posted to GitHub: its check run and Deployment ids. */
export type ReportedBuild = {
  id: string
  app: string
  sha: string
  state: BuildState
  checkRunId: number | null
  deploymentId: number | null
  /** The final state reached GitHub. */
  reported: boolean
  createdAt: string
}

/** The newest builds that posted a check run or a Deployment. */
export async function recentReported(limit = 10): Promise<ReportedBuild[]> {
  const rows = await db
    .select({
      id: builds.id,
      app: apps.name,
      sha: builds.sha,
      state: builds.state,
      checkRunId: builds.checkRunId,
      deploymentId: builds.deploymentId,
      reported: builds.reported,
      createdAt: builds.createdAt,
    })
    .from(builds)
    .innerJoin(apps, eq(apps.id, builds.appId))
    .where(or(isNotNull(builds.checkRunId), isNotNull(builds.deploymentId)))
    .orderBy(desc(builds.createdAt))
    .limit(limit)
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }))
}
