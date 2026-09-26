import { requireActor } from '../core/auth'
import type { BuildNowResult, CancelBuildResult } from '../core/builds/actions'
import type { Ctx } from '../core/ctx'
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
import { BUILD_SHA_RE } from '../lib/builds'
import { asValidator, is, obj, str, withMessage } from '../lib/contract/decode'
import { appNameField, pageSizeField } from '../lib/contract/fields'
import type { Result } from '../lib/result'
import { adminFn, readFn } from './fn'

// Server functions behind the build UI: the builds board, the build page, the
// Build now, Cancel and Retry report buttons and an app's build settings.
// Value imports of anything that touches the database are dynamic, so it stays
// out of the client bundle (server/registry.ts does the same). core/auth and
// the request decoders are pure and imported statically on purpose: what a
// request has to prove should be legible from the top of the file.

const LOG_TAIL_BYTES = 64_000

/** `{ app }`, which is what all but two requests here carry. */
const appRequest = withMessage(obj({ app: appNameField }), 'expected an app name')

/** `{ app, id }`: a build, named under the app whose page is asking. */
const buildRequest = withMessage(
  obj({ id: withMessage(str, 'expected a build id'), app: appNameField }),
  'expected a build',
)

const summarize = (row: BuildRow): BuildSummary => summarizeBuild(row)

/** The recent builds of one app, newest first; null when there is no such app. */
export const fetchBuilds = readFn
  // `limit` is clamped rather than refused: it is a page size, and the only
  // wrong answer is one that lets a request ask for the whole table.
  .validator(
    asValidator(
      withMessage(obj({ app: appNameField, limit: pageSizeField(50, 10) }), 'expected an app name'),
    ),
  )
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
export const fetchBuildApp = readFn
  .validator(asValidator(appRequest))
  .handler(async ({ data }): Promise<BuildPageApp | null> => {
    const { getApp } = await import('../lib/repo/apps')
    const { effectiveHostname } = await import('../lib/hostname')
    const { readSite } = await import('../host/site')
    const r = await getApp(data.app)
    if (!r) return null
    return {
      name: r.name,
      stage: r.stage,
      effectiveHostname: effectiveHostname(readSite(), r.name, r.hostname),
      postgres: r.postgres,
      egressContainer: r.egressContainer,
      buildOnBox: r.buildOnBox,
      linked: r.githubRepoId !== null && !r.managedInNix && r.sourceMode !== 'local',
    }
  })

/** The reporter's failure record for one build, for the page; null when there is none. */
async function reportFailureOf(
  id: string,
  ctx: () => Promise<Ctx>,
): Promise<BuildReportFailure | null> {
  const { readReportFailures } = await import('../core/builds/report')
  const f = (await readReportFailures(await ctx()))[id]
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
export const fetchBuild = readFn
  .validator(asValidator(buildRequest))
  .handler(async ({ data, context }): Promise<BuildView | null> => {
    const { getBuild, toBuildRow } = await import('../lib/repo/builds')
    // getBuild answers undefined for anything that is not a uuid.
    const record = await getBuild(data.id)
    if (!record || record.app !== data.app) return null

    const { getApp } = await import('../lib/repo/apps')
    const { deploymentOfDigest } = await import('../lib/repo/build-views')
    const { detectionFromStatus } = await import('../lib/build-detect')
    const { readBuildLogTail } = await import('../host/build-bridge')
    const { deployOutcome } = await import('../lib/build-display')

    const row = toBuildRow(record)
    const [app, log, deployment, reportFailure] = await Promise.all([
      getApp(data.app),
      readBuildLogTail(row.id, { maxBytes: LOG_TAIL_BYTES }),
      row.state === 'succeeded' && row.digest !== null
        ? deploymentOfDigest(row.appId, row.digest)
        : Promise.resolve(undefined),
      row.reported ? Promise.resolve(null) : reportFailureOf(row.id, context.ctx),
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
      facts: row.facts,
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

/**
 * The author and message of a build's commit, asked of GitHub as the App.
 * Its own function because fetchBuild is polled every 3 s and this must not
 * be; null when GitHub cannot say.
 */
export const fetchBuildCommit = readFn
  .validator(
    asValidator(
      withMessage(
        obj({
          app: appNameField,
          sha: withMessage(
            is((v: unknown): v is string => typeof v === 'string' && BUILD_SHA_RE.test(v), 'a sha'),
            'expected a commit sha',
          ),
        }),
        'expected an app name',
      ),
    ),
  )
  .handler(async ({ data, context }): Promise<BuildCommit | null> => {
    const key = `${data.app}@${data.sha}`
    const cached = COMMITS.get(key)
    if (cached !== undefined) return cached

    const { getApp } = await import('../lib/repo/apps')
    const record = await getApp(data.app)
    if (!record || record.githubRepoId === null) return null
    const { ghApp, repoById } = await import('../core/github-app')
    const ctx = await context.ctx()
    // By id: the app's name is a label, and a renamed repo still answers here.
    const found = await repoById(ctx, record.githubRepoId)
    if (!found.ok) return null
    const r = await ghApp<{
      html_url?: unknown
      commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } }
      author?: { login?: unknown } | null
    }>(ctx, `/repos/${found.value.fullName}/commits/${data.sha}`)
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

/** The build row the click produced. Re-exported: the shape is core/builds/actions.ts's. */
export type { BuildNowResult, CancelBuildResult } from '../core/builds/actions'

/**
 * Build now, as the button's door onto `core/builds/actions.ts buildNow`.
 *
 * Everything this adds is WHO: the admin gate, then the signed-in identity the
 * row and the journal line are recorded under. What to build and what to
 * refuse is one implementation, shared with the MCP tool of the same name.
 */
export const buildNowFn = adminFn
  .validator(asValidator(appRequest))
  .handler(async ({ data }): Promise<BuildNowResult> => {
    // adminFn's check runs before this identity gate, not instead of it: its
    // refusal is a broken gate rather than an answer, so it throws where
    // requireActor returns.
    const gate = requireActor()
    if (!gate.ok) return { ok: false, reason: gate.reason }

    const { buildNow } = await import('../core/builds/actions')
    return buildNow({ app: data.app, actor: gate.value })
  })

/** Cancel, as the button's door onto `core/builds/actions.ts cancelBuild`. */
export const cancelBuildFn = adminFn
  .validator(asValidator(buildRequest))
  .handler(async ({ data }): Promise<CancelBuildResult> => {
    const gate = requireActor()
    if (!gate.ok) return { ok: false, reason: gate.reason }

    const { cancelBuild } = await import('../core/builds/actions')
    return cancelBuild({ app: data.app, id: data.id, actor: gate.value })
  })

export type RetryReportResult = Result<null>

/**
 * Retry report: forget a build's failed GitHub report and post it now, however
 * many retries it spent (core/builds/report.ts retryReport). Not ok when GitHub
 * refuses again, with what it said.
 */
export const retryReportFn = adminFn
  .validator(asValidator(buildRequest))
  .handler(async ({ data, context }): Promise<RetryReportResult> => {
    const gate = requireActor()
    if (!gate.ok) return { ok: false, reason: gate.reason }
    const actor = gate.value

    const { getBuild } = await import('../lib/repo/builds')
    const record = await getBuild(data.id)
    if (!record || record.app !== data.app) return { ok: false, reason: 'No such build.' }
    if (record.reported) return { ok: true, value: null }

    const { readReportFailures, retryReport } = await import('../core/builds/report')
    const ctx = await context.ctx()
    await retryReport(ctx, record.id)
    console.info(
      `[builds] ${actor} retried the GitHub report of ${data.app}@${record.sha.slice(0, 7)} (${record.id})`,
    )
    const again = (await readReportFailures(ctx))[record.id]
    if (again === undefined) return { ok: true, value: null }
    return {
      ok: false,
      reason: `GitHub refused it again: ${again.kind}${again.status === null ? '' : ` (HTTP ${String(again.status)})`}.`,
    }
  })

export type BuildSettingsResult = Result<null>

/**
 * Apps › <name> › Settings › Builds. The columns are engine-only, so a save
 * here never reaches the Apply bar or a rebuild.
 */
export const setBuildSettingsFn = adminFn
  .validator(
    (input: { app: string } & BuildSettingsPatch): { app: string; patch: BuildSettingsPatch } =>
      validateBuildSettings(input),
  )
  .handler(async ({ data }): Promise<BuildSettingsResult> => {
    const gate = requireActor()
    if (!gate.ok) return { ok: false, reason: gate.reason }
    const actor = gate.value

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
    return { ok: true, value: null }
  })
