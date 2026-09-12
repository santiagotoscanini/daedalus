import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import {
  type BuildCommit,
  type BuildReportFailure,
  type BuildSummary,
  type BuildView,
  summarizeBuild,
} from '../lib/build-display'
import type { BuildRow } from '../lib/build-queue'
import {
  type BuildSettingsPatch,
  buildEnvSizeError,
  validateBuildSettings,
} from '../lib/build-settings'
import {
  BUILD_PUBLISH_MODES,
  BUILD_STRATEGIES,
  type BuildPublish,
  type BuildStrategy,
} from '../lib/builds'

// Server functions behind the build UI: the builds board, the build page, the
// Build now and Retry report buttons and an app's build settings. Value imports
// of anything that touches the database are dynamic, so it stays out of the
// client bundle (server/registry.ts does the same).

const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const SHA_RE = /^[0-9a-f]{40}$/
const LOG_TAIL_BYTES = 64_000

function appName(v: unknown): string {
  if (typeof v !== 'string' || !APP_NAME_RE.test(v)) throw new Error('expected an app name')
  return v
}

const summarize = (row: BuildRow): BuildSummary => summarizeBuild(row)

/** The recent builds of one app, newest first; null when there is no such app. */
export const fetchBuilds = createServerFn()
  .validator((input: { app: string; limit?: number }) => ({
    app: appName(input.app),
    limit:
      typeof input.limit === 'number' && Number.isInteger(input.limit)
        ? Math.min(50, Math.max(1, input.limit))
        : 10,
  }))
  .handler(async ({ data }): Promise<BuildSummary[] | null> => {
    const { getApp } = await import('../lib/repo/apps')
    const { listBuilds, toBuildRow } = await import('../lib/repo/builds')
    const record = await getApp(data.app)
    if (!record) return null
    return (await listBuilds(record.id, data.limit)).map((r) => summarize(toBuildRow(r)))
  })

export type BuildPageApp = {
  name: string
  stage: string
  effectiveHostname: string
  /** The two facts the app rail needs to decide its conditional sections. */
  postgres: boolean
  egressContainer: string | null
  buildOnBox: boolean
  /** Matched to its GitHub repository by the sweep, and buildable at all. */
  linked: boolean
}

/** The app around a build page: one row, for the rail and the Build again button. */
export const fetchBuildApp = createServerFn()
  .validator((input: { app: string }) => ({ app: appName(input.app) }))
  .handler(async ({ data }): Promise<BuildPageApp | null> => {
    const { getApp } = await import('../lib/repo/apps')
    const { effectiveHostname } = await import('../lib/hostname')
    const r = await getApp(data.app)
    if (!r) return null
    return {
      name: r.name,
      stage: r.stage,
      effectiveHostname: effectiveHostname(r.name, r.hostname),
      postgres: r.postgres,
      egressContainer: r.egressContainer,
      buildOnBox: r.buildOnBox,
      linked: r.githubRepoId !== null && !r.managedInNix && r.sourceMode !== 'local',
    }
  })

/** The reporter's failure record for one build, for the page; null when there is none. */
async function reportFailureOf(id: string): Promise<BuildReportFailure | null> {
  const { makeCtx } = await import('../core/ctx')
  const { readReportFailures } = await import('../core/builds/report')
  const f = (await readReportFailures(await makeCtx()))[id]
  if (f === undefined) return null
  return {
    step: f.step,
    kind: f.kind,
    status: f.status,
    attempts: f.attempts,
    at: f.at,
    gaveUp: f.gaveUp,
  }
}

/**
 * One build as its page shows it: the row, its detection decoded, the cached
 * warnings, the log's last 64 KB, what became of the image, and a failed
 * GitHub report while there is one. Null for an unknown id, and for another
 * app's build under this app's URL.
 */
export const fetchBuild = createServerFn()
  .validator((input: { app: string; id: string }) => {
    if (typeof input.id !== 'string') throw new Error('expected a build id')
    return { app: appName(input.app), id: input.id }
  })
  .handler(async ({ data }): Promise<BuildView | null> => {
    const { getBuild, toBuildRow } = await import('../lib/repo/builds')
    // getBuild answers undefined for anything that is not a uuid.
    const record = await getBuild(data.id)
    if (!record || record.app !== data.app) return null

    const { getApp } = await import('../lib/repo/apps')
    const { deploymentOfDigest } = await import('../lib/repo/build-views')
    const { detectionFromStatus } = await import('../lib/build-detect')
    const { readBuildLogTail } = await import('../lib/build-bridge')
    const { deployOutcome } = await import('../lib/build-display')

    const row = toBuildRow(record)
    const [app, log, deployment, reportFailure] = await Promise.all([
      getApp(data.app),
      readBuildLogTail(row.id, { maxBytes: LOG_TAIL_BYTES }),
      row.state === 'succeeded' && row.digest !== null
        ? deploymentOfDigest(row.appId, row.digest)
        : Promise.resolve(undefined),
      row.reported ? Promise.resolve(null) : reportFailureOf(row.id),
    ])

    return {
      ...summarize(row),
      app: row.app,
      reportFailure,
      detection: detectionFromStatus(row.detected),
      warnings: row.warnings,
      checks: row.checks,
      digest: row.digest,
      imageRef: row.imageRef,
      sizeBytes: row.sizeBytes,
      timings: row.timings,
      checkRunId: row.checkRunId,
      deploymentId: row.deploymentId,
      deploy: deployOutcome({
        state: row.state,
        publish: row.publish,
        digest: row.digest,
        deployEnable: app?.deployEnable ?? true,
        imageOverride: app?.image ?? null,
        deployment:
          deployment === undefined
            ? null
            : {
                result: deployment.result,
                startedAt: deployment.startedAt.toISOString(),
                httpCode: deployment.httpCode,
              },
      }),
      log,
    }
  })

// A commit never changes, so what GitHub said about one is kept for the life
// of the module (a re-evaluation only empties it). Bounded, oldest out first.
const COMMITS = new Map<string, BuildCommit>()
const COMMITS_MAX = 200

type RepoBody = { id?: unknown; full_name?: unknown; default_branch?: unknown }

/**
 * The author and message of a build's commit, asked of GitHub as the App.
 * Its own function because fetchBuild is polled every 3 s and this must not
 * be; null when GitHub cannot say.
 */
export const fetchBuildCommit = createServerFn()
  .validator((input: { app: string; sha: string }) => {
    if (typeof input.sha !== 'string' || !SHA_RE.test(input.sha)) {
      throw new Error('expected a commit sha')
    }
    return { app: appName(input.app), sha: input.sha }
  })
  .handler(async ({ data }): Promise<BuildCommit | null> => {
    const key = `${data.app}@${data.sha}`
    const cached = COMMITS.get(key)
    if (cached !== undefined) return cached

    const { getApp } = await import('../lib/repo/apps')
    const record = await getApp(data.app)
    if (!record || record.githubRepoId === null) return null
    const { makeCtx } = await import('../core/ctx')
    const { ghApp } = await import('../core/github-app')
    const ctx = await makeCtx()
    const repo = await ghApp<RepoBody>(ctx, `/repositories/${String(record.githubRepoId)}`)
    if (repo.status !== 200 || typeof repo.body?.full_name !== 'string') return null
    const r = await ghApp<{
      html_url?: unknown
      commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } }
      author?: { login?: unknown } | null
    }>(ctx, `/repos/${repo.body.full_name}/commits/${data.sha}`)
    if (r.status !== 200 || r.body === null) return null

    const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
    const commit: BuildCommit = {
      message: text(r.body.commit?.message) ?? '',
      author: text(r.body.author?.login) ?? text(r.body.commit?.author?.name),
      authoredAt: text(r.body.commit?.author?.date),
      htmlUrl: text(r.body.html_url),
    }
    if (COMMITS.size >= COMMITS_MAX) {
      const oldest = COMMITS.keys().next().value
      if (oldest !== undefined) COMMITS.delete(oldest)
    }
    COMMITS.set(key, commit)
    return commit
  })

export type BuildNowResult =
  | { ok: true; id: string; sha: string; existing: boolean }
  | { ok: false; reason: string }

const orDefault = <T extends string>(allowed: readonly T[], v: string, fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback

/**
 * Build the default branch's tip now. The tip is asked of GitHub, never taken
 * from the page. Refused without a signed-in identity, for an app whose box
 * builds are off, and for one the sweep has not linked to its repository yet.
 *
 * Always forced: insertOrSupersedeQueued has no "already built" skip (only
 * build-queue.ts `enqueue` does), so pressing this on a tip that already built
 * builds it again, which is what "Build again" means. A build of the same sha
 * already queued or running is the answer instead of a second one.
 */
export const buildNowFn = createServerFn({ method: 'POST' })
  .validator((input: { app: string }) => ({ app: appName(input.app) }))
  .handler(async ({ data }): Promise<BuildNowResult> => {
    const { actorFrom, NO_ACTOR_REASON } = await import('../core/settings/github-app')
    const actor = actorFrom(getRequestHeader('x-forwarded-email'))
    if (actor === null) return { ok: false, reason: NO_ACTOR_REASON }

    const { getApp } = await import('../lib/repo/apps')
    const record = await getApp(data.app)
    if (!record) return { ok: false, reason: `No app named ${data.app}.` }
    if (record.managedInNix || record.sourceMode === 'local') {
      return { ok: false, reason: `${data.app} runs its working tree; there is nothing to build.` }
    }
    if (!record.buildOnBox) {
      return {
        ok: false,
        reason: `Box builds are off for ${data.app}. Turn on Build on this box in its settings.`,
      }
    }
    if (record.githubRepoId === null) {
      return {
        ok: false,
        reason:
          'Waiting for the sweep to link the repo: the box has not matched this app to a GitHub repository yet.',
      }
    }

    const { makeCtx } = await import('../core/ctx')
    const { ghApp, describeGhFailure } = await import('../core/github-app')
    const ctx = await makeCtx()
    // By id rather than owner/name: the id is what the sweep linked. The host
    // still reads the repository by the app's name, so a renamed one fails there.
    const repo = await ghApp<RepoBody>(ctx, `/repositories/${String(record.githubRepoId)}`)
    if (repo.status !== 200 || repo.body === null) {
      return { ok: false, reason: describeGhFailure(repo) }
    }
    const { id, full_name: fullName, default_branch: branch } = repo.body
    if (id !== record.githubRepoId || typeof fullName !== 'string' || typeof branch !== 'string') {
      return { ok: false, reason: 'GitHub answered with a repository this app is not linked to.' }
    }
    const tip = await ghApp<{ sha?: unknown }>(
      ctx,
      `/repos/${fullName}/commits/${encodeURIComponent(branch)}`,
    )
    if (tip.status !== 200 || tip.body === null) {
      return { ok: false, reason: describeGhFailure(tip) }
    }
    const sha = tip.body.sha
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
      return { ok: false, reason: `GitHub did not name a commit at the tip of ${branch}.` }
    }

    const { openBuildOf } = await import('../lib/repo/build-views')
    const open = await openBuildOf(record.id, sha)
    if (open !== undefined) return { ok: true, id: open.id, sha, existing: true }

    const { insertOrSupersedeQueued } = await import('../lib/repo/builds')
    const enqueued = await insertOrSupersedeQueued({
      appId: record.id,
      sha,
      strategy: orDefault<BuildStrategy>(BUILD_STRATEGIES, record.buildStrategy, 'auto'),
      publish: orDefault<BuildPublish>(BUILD_PUBLISH_MODES, record.buildPublish, 'live'),
      requestedBy: 'operator',
      actor,
    })
    const { ensureScheduler } = await import('../core/builds/scheduler')
    ensureScheduler()
    console.info(
      `[builds] ${actor} queued ${data.app}@${sha.slice(0, 7)} as ${enqueued.row.id}` +
        (enqueued.superseded.length > 0
          ? `, superseding ${String(enqueued.superseded.length)}`
          : ''),
    )
    return { ok: true, id: enqueued.row.id, sha, existing: enqueued.alreadyQueued }
  })

export type RetryReportResult = { ok: true } | { ok: false; reason: string }

/**
 * Retry report: forget a build's failed GitHub report and post it now, however
 * many retries it spent (core/builds/report.ts retryReport). Not ok when GitHub
 * refuses again, with what it said.
 */
export const retryReportFn = createServerFn({ method: 'POST' })
  .validator((input: { app: string; id: string }) => {
    if (typeof input.id !== 'string') throw new Error('expected a build id')
    return { app: appName(input.app), id: input.id }
  })
  .handler(async ({ data }): Promise<RetryReportResult> => {
    const { actorFrom, NO_ACTOR_REASON } = await import('../core/settings/github-app')
    const actor = actorFrom(getRequestHeader('x-forwarded-email'))
    if (actor === null) return { ok: false, reason: NO_ACTOR_REASON }

    const { getBuild } = await import('../lib/repo/builds')
    const record = await getBuild(data.id)
    if (!record || record.app !== data.app) return { ok: false, reason: 'No such build.' }
    if (record.reported) return { ok: true }

    const { makeCtx } = await import('../core/ctx')
    const { readReportFailures, retryReport } = await import('../core/builds/report')
    const ctx = await makeCtx()
    await retryReport(ctx, record.id)
    console.info(
      `[builds] ${actor} retried the GitHub report of ${data.app}@${record.sha.slice(0, 7)} (${record.id})`,
    )
    const again = (await readReportFailures(ctx))[record.id]
    if (again === undefined) return { ok: true }
    return {
      ok: false,
      reason: `GitHub refused it again: ${again.kind}${again.status === null ? '' : ` (HTTP ${String(again.status)})`}.`,
    }
  })

export type BuildSettingsResult = { ok: true } | { ok: false; reason: string }

/**
 * Apps › <name> › Settings › Builds. The columns are engine-only, so a save
 * here never reaches the Apply bar or a rebuild.
 */
export const setBuildSettingsFn = createServerFn({ method: 'POST' })
  .validator(
    (input: { app: string } & BuildSettingsPatch): { app: string; patch: BuildSettingsPatch } =>
      validateBuildSettings(input),
  )
  .handler(async ({ data }): Promise<BuildSettingsResult> => {
    const { actorFrom, NO_ACTOR_REASON } = await import('../core/settings/github-app')
    const actor = actorFrom(getRequestHeader('x-forwarded-email'))
    if (actor === null) return { ok: false, reason: NO_ACTOR_REASON }

    const { getApp } = await import('../lib/repo/apps')
    const record = await getApp(data.app)
    if (!record) return { ok: false, reason: `No app named ${data.app}.` }
    if (record.managedInNix || record.sourceMode === 'local') {
      return { ok: false, reason: `${data.app} runs its working tree; it has no builds to set.` }
    }
    const { buildEnvPlaceholders, railpackEnv } = data.patch
    if (buildEnvPlaceholders !== undefined || railpackEnv !== undefined) {
      // The cap is on both maps as a request carries them; a patch may hold one.
      const tooBig = buildEnvSizeError(
        buildEnvPlaceholders ?? record.buildEnvPlaceholders,
        railpackEnv ?? record.railpackEnv,
      )
      if (tooBig !== null) return { ok: false, reason: tooBig }
    }
    const { updateBuildSettings } = await import('../lib/repo/build-views')
    await updateBuildSettings(data.app, data.patch)
    console.info(`[builds] ${actor} set ${Object.keys(data.patch).join(', ')} on ${data.app}`)
    return { ok: true }
  })
