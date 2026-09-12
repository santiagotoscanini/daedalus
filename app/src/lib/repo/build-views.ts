import { and, desc, eq, inArray } from 'drizzle-orm'
import { detectionFromStatus } from '../build-detect'
import { type BuildSummary, summarizeBuild } from '../build-display'
import type { BuildSettingsPatch } from '../build-settings'
import { ACTIVE_BUILD_STATES } from '../builds'
import { db } from '../db'
import { apps, builds, deployments } from '../schema'
import { latestSucceeded, listBuilds, toBuildRow } from './builds'

// The reads the build UI needs that lib/repo/builds.ts (the queue's own
// repository) does not have, and the one write to an app's engine-only build
// columns.

/**
 * Write the build settings. Deliberately not updateApp: these columns are not
 * EDITABLE_FIELDS, nix never reads them, and updatedAt is left alone so a
 * build setting never reads as a registry edit.
 */
export async function updateBuildSettings(name: string, patch: BuildSettingsPatch): Promise<void> {
  const set: Partial<typeof apps.$inferInsert> = {}
  if (patch.buildOnBox !== undefined) set.buildOnBox = patch.buildOnBox
  if (patch.buildStrategy !== undefined) set.buildStrategy = patch.buildStrategy
  if (patch.buildPublish !== undefined) set.buildPublish = patch.buildPublish
  if (patch.buildEnvPlaceholders !== undefined) {
    set.buildEnvPlaceholders = patch.buildEnvPlaceholders
  }
  if (patch.railpackEnv !== undefined) set.railpackEnv = patch.railpackEnv
  if (Object.keys(set).length === 0) return
  await db.update(apps).set(set).where(eq(apps.name, name))
}

/** The builds board's rows, newest first. */
export async function recentBuilds(appId: string, limit = 10): Promise<BuildSummary[]> {
  return (await listBuilds(appId, limit)).map((r) => summarizeBuild(toBuildRow(r)))
}

/** The overview's detection line: the last successful main-lane build, or null. */
export async function overviewBuild(appId: string) {
  const r = await latestSucceeded(appId)
  if (r === undefined) return null
  const row = toBuildRow(r)
  return {
    summary: summarizeBuild(row),
    detection: detectionFromStatus(row.detected),
    warningCount: row.warnings.length,
  }
}

/** A build of this sha that is queued or running in the lane, if any. */
export async function openBuildOf(
  appId: string,
  sha: string,
  lane = 'main',
): Promise<{ id: string; state: string } | undefined> {
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

/**
 * The newest deploy that landed this digest. deploy.sh records digests as
 * `sha256:<hex>`; a build status may or may not carry the prefix.
 */
export async function deploymentOfDigest(appId: string, digest: string) {
  const hex = digest.replace(/^sha256:/, '')
  const [row] = await db
    .select({
      result: deployments.result,
      startedAt: deployments.startedAt,
      httpCode: deployments.httpCode,
    })
    .from(deployments)
    .where(and(eq(deployments.appId, appId), inArray(deployments.digest, [hex, `sha256:${hex}`])))
    .orderBy(desc(deployments.startedAt))
    .limit(1)
  return row
}
