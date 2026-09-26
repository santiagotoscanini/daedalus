// Builds on the box: what GitHub hears about a build — the `daedalus` check run
// and, for live deploys, a Deployment and its statuses.
//
//   progress   the first time a build is seen past `queued`, a check run is
//              created in progress (Details → the build page); phase changes
//              PATCH it, at most once every 10 s. A change that lands inside
//              that window is sent by a later tick.
//   final      the run is completed with the whole story: strategy, detection
//              and its warnings, checks, timings, image, and the log tail in a
//              code fence. A succeeded live build of a deployable app then gets
//              a Deployment in progress; candidate and pinned builds get none.
//   deployed   on its own tick, deploy.sh's journal is ingested and the
//              Deployment is matched on the pushed digest (else the revision):
//              ok → success, failed → failure, a newer build landing first →
//              inactive, nothing within 30 min → error.
//
// `reported` goes true only once there is nothing left to post. Nothing here
// throws. A GitHub failure is logged once and recorded (the store key below),
// retried 3 times on a widening delay, and then left for "Retry report"
// (retryReport). A rate limit is not a failure: every call waits it out.
//
// This file is the GitHub orchestration. The words it posts, and the deploy
// matching, are lib/build-report-text.ts (pure); the per-process memo and the
// failure record are report-memo.ts.

import type { BuildRow } from '../../lib/build-queue'
import {
  type AppFacts,
  CONCLUSION,
  type Delivery,
  type DeployLike,
  deliveryOf,
  deployStatus,
  fenceLog,
  matchDeploy,
  sha7,
  summaryOf,
  titleText,
} from '../../lib/build-report-text'
import { isActiveBuildState, isTerminalBuildState } from '../../lib/builds'
import { checkRunOutput } from '../../lib/github-app'
import { effectiveHostname } from '../../lib/hostname'
import { errorText } from '../../lib/redact'
import { stageExposed } from '../../lib/stage'
import type { Ctx } from '../ctx'
import {
  clampChars,
  createCheckRun,
  createDeployment,
  createDeploymentStatus,
  type DeploymentState,
  type RepoRef,
  updateCheckRun,
} from '../github-checks'
import type { SiteGithubApp } from '../site/file'
import { block, clearFailure, failures, logOnce, mayCall, memo, recordFailure } from './report-memo'

export { readReportFailures } from './report-memo'

const PATCH_MIN_INTERVAL_MS = 10_000
/** A live build whose Deployment sees no deploy this long after it finished gets `error`. */
export const DEPLOY_WAIT_MS = 30 * 60_000
/** Older unreported builds are left alone by the tick; retryReport still reaches them. */
const REPORT_WINDOW_MS = 24 * 60 * 60_000
/** Unreported builds a tick may work on. */
const TICK_BUDGET = 5
/** Unreported builds a tick reads: newest first, within REPORT_WINDOW_MS. */
const UNREPORTED_READ = 20
const TICK_MIN_INTERVAL_MS = 5_000
const INGEST_MIN_INTERVAL_MS = 15_000
const TITLE_MAX_CHARS = 200

// ── what the row says ───────────────────────────────────────────────────────

type SiteFacts = {
  app: SiteGithubApp | null
  /** The box's name for titles: site.json `identity.hostname`. */
  box: string
  controlPlane: string | null
}

/** The control plane host as core/settings/github-app.ts derives it. Never a request header. */
async function siteFacts(ctx: Ctx): Promise<SiteFacts> {
  const { readCommittedSite } = await import('../../host/contract/domains/site-doc')
  const site = await readCommittedSite()
  const doc = site.ok ? site.value.doc : null
  let controlPlane: string | null = null
  if (doc !== null && doc.identity.controlPlane !== '' && doc.identity.baseDomain !== '') {
    controlPlane = `${doc.identity.controlPlane}.${doc.identity.baseDomain}`
  } else {
    const { siteIdentity } = await import('../../host/contract/domains/site')
    const host = (await siteIdentity()).data.controlPlane.hostname ?? ctx.env('APP_HOSTNAME') ?? ''
    controlPlane = host === '' ? null : host
  }
  return {
    app: doc?.github?.app ?? null,
    box: doc !== null && doc.identity.hostname !== '' ? doc.identity.hostname : 'the box',
    controlPlane,
  }
}

function buildUrl(site: SiteFacts, row: BuildRow): string | null {
  if (site.controlPlane === null) return null
  return `https://${site.controlPlane}/apps/${encodeURIComponent(row.app)}/builds/${encodeURIComponent(row.id)}`
}

/** The check run's title, clamped to what GitHub keeps. */
export function titleOf(row: BuildRow, site: SiteFacts, delivery: Delivery | null): string {
  return clampChars(titleText(row, site.box, delivery), TITLE_MAX_CHARS)
}

// ── reporting ───────────────────────────────────────────────────────────────

async function save(
  id: string,
  report: { checkRunId?: number; deploymentId?: number; reported?: boolean },
): Promise<void> {
  try {
    const { markReported } = await import('../../lib/repo/builds')
    await markReported(id, report)
  } catch (e) {
    logOnce(
      id,
      `db:${Object.keys(report).join(',')}`,
      `could not record the report: ${errorText(e)}`,
    )
  }
}

async function finish(ctx: Ctx, row: BuildRow): Promise<void> {
  await save(row.id, { reported: true })
  await clearFailure(ctx, row.id)
  const m = memo()
  m.sent.delete(row.id)
  m.checkRuns.delete(row.id)
  m.deployments.delete(row.id)
  m.completed.delete(row.id)
  for (const k of m.logged) if (k.startsWith(`${row.id}:`)) m.logged.delete(k)
}

/** The row's check run id: the row, this process, or (before creating one) the database. */
async function checkRunIdOf(row: BuildRow, askDatabase: boolean): Promise<number | null> {
  const known = row.checkRunId ?? memo().checkRuns.get(row.id) ?? null
  if (known !== null || !askDatabase) return known
  const { getBuild } = await import('../../lib/repo/builds')
  return (await getBuild(row.id))?.checkRunId ?? null
}

async function reportProgress(
  ctx: Ctx,
  row: BuildRow,
  repo: RepoRef,
  site: SiteFacts,
): Promise<void> {
  const m = memo()
  const out = checkRunOutput({
    title: titleOf(row, site, null),
    summary: summaryOf(row, null),
    logTail: '',
  })
  const output = { title: out.title, summary: out.summary }
  const id = await checkRunIdOf(row, true)

  if (id === null) {
    const call = await createCheckRun(ctx, repo, {
      headSha: row.sha,
      buildId: row.id,
      detailsUrl: buildUrl(site, row),
      startedAt: row.startedAt ?? row.createdAt,
      output,
    })
    if (!call.ok) return recordFailure(ctx, row, 'check-run', call)
    m.checkRuns.set(row.id, call.value.id)
    m.sent.set(row.id, { at: Date.now(), state: row.state, phase: row.phase })
    await clearFailure(ctx, row.id)
    await save(row.id, { checkRunId: call.value.id })
    return
  }
  m.checkRuns.set(row.id, id)

  const last = m.sent.get(row.id)
  if (last !== undefined && last.state === row.state && last.phase === row.phase) return
  if (last !== undefined && Date.now() - last.at < PATCH_MIN_INTERVAL_MS) return
  // Stamped before the call: a failed PATCH still spaces the next one.
  m.sent.set(row.id, { at: Date.now(), state: row.state, phase: row.phase })
  const call = await updateCheckRun(ctx, repo, id, { status: 'in_progress', output })
  if (call.ok) return
  // Progress is cosmetic: it spends no retries, and the final report follows.
  if (call.failure === 'rate-limited') block(call.retryAfterMs)
  else logOnce(row.id, `progress:${call.failure}`, `progress update failed: ${call.failure}`)
}

/**
 * The row with its detection, checks, timings and warnings. The scheduler and
 * the tick hand over list rows, which carry none of them; only the completed
 * check run's story needs them, so they are read here, once per report.
 */
async function withDetails(row: BuildRow): Promise<BuildRow> {
  const { getBuild, toBuildRow } = await import('../../lib/repo/builds')
  const record = await getBuild(row.id)
  return record !== undefined && record.id === row.id ? toBuildRow(record) : row
}

async function reportFinal(ctx: Ctx, row: BuildRow, repo: RepoRef, site: SiteFacts): Promise<void> {
  const m = memo()
  const { getApp } = await import('../../lib/repo/apps')
  const app = (await getApp(row.app)) ?? null
  const delivery = row.state === 'succeeded' ? deliveryOf(row, app) : null

  const deploymentId = row.deploymentId ?? m.deployments.get(row.id) ?? null
  if (row.state === 'succeeded' && deploymentId !== null) {
    return followDeployment(ctx, row, repo, site, app, deploymentId)
  }

  if (!(await completeCheckRun(ctx, row, repo, site, delivery))) return
  if (row.state === 'succeeded' && delivery === 'deploy')
    return openDeployment(ctx, row, repo, site)
  await finish(ctx, row)
}

/**
 * Complete the check run with the whole story, once per final state. False
 * when GitHub refused it: the failure is recorded and the report stops there.
 */
async function completeCheckRun(
  ctx: Ctx,
  row: BuildRow,
  repo: RepoRef,
  site: SiteFacts,
  delivery: Delivery | null,
): Promise<boolean> {
  const m = memo()
  const conclusion = CONCLUSION[row.state]
  if (conclusion !== undefined && m.completed.get(row.id) !== row.state) {
    const { readBuildLogTail } = await import('../../host/build-bridge')
    const [tail, whole] = await Promise.all([readBuildLogTail(row.id), withDetails(row)])
    const out = checkRunOutput({
      title: titleOf(whole, site, delivery),
      summary: summaryOf(whole, delivery),
      logTail: tail.available ? tail.text : '',
    })
    const output = {
      title: out.title,
      summary: out.summary,
      ...(out.text.trim() === '' ? {} : { text: fenceLog(out.text) }),
    }
    const id = await checkRunIdOf(row, true)
    const call =
      id === null
        ? await createCheckRun(ctx, repo, {
            headSha: row.sha,
            buildId: row.id,
            detailsUrl: buildUrl(site, row),
            startedAt: row.startedAt ?? row.createdAt,
            output,
            conclusion,
            completedAt: row.updatedAt,
          })
        : await updateCheckRun(ctx, repo, id, { conclusion, completedAt: row.updatedAt, output })
    if (!call.ok) {
      await recordFailure(ctx, row, 'check-run', call)
      return false
    }
    m.completed.set(row.id, row.state)
    m.sent.delete(row.id)
    if (id === null) {
      m.checkRuns.set(row.id, call.value.id)
      await save(row.id, { checkRunId: call.value.id })
    }
  }
  return true
}

/** A succeeded live build's Deployment, in progress until its deploy is matched. */
async function openDeployment(
  ctx: Ctx,
  row: BuildRow,
  repo: RepoRef,
  site: SiteFacts,
): Promise<void> {
  const m = memo()
  const call = await createDeployment(ctx, repo, {
    sha: row.sha,
    buildId: row.id,
    description: `Built on ${site.box}`,
  })
  if (!call.ok) return recordFailure(ctx, row, 'deployment', call)
  m.deployments.set(row.id, call.value.id)
  await save(row.id, { deploymentId: call.value.id })
  await clearFailure(ctx, row.id)
  const status = await createDeploymentStatus(ctx, repo, call.value.id, {
    state: 'in_progress',
    description: 'Waiting for the deploy timer to pull the new image.',
    logUrl: buildUrl(site, row),
  })
  // The final status does not depend on this one landing.
  if (!status.ok) {
    if (status.failure === 'rate-limited') block(status.retryAfterMs)
    else
      logOnce(
        row.id,
        `in-progress:${status.failure}`,
        `in_progress status failed: ${status.failure}`,
      )
  }
}

async function followDeployment(
  ctx: Ctx,
  row: BuildRow,
  repo: RepoRef,
  site: SiteFacts,
  app: AppFacts | null,
  deploymentId: number,
): Promise<void> {
  const m = memo()
  const logUrl = buildUrl(site, row)
  let status: { state: DeploymentState; description: string; environmentUrl?: string | null }

  if (app === null) {
    status = { state: 'error', description: `${row.app} is no longer registered on ${site.box}.` }
  } else {
    const deployments = await import('../../lib/repo/deployments')
    const now = Date.now()
    if (now - (m.ingestedAt.get(row.appId) ?? 0) >= INGEST_MIN_INTERVAL_MS) {
      m.ingestedAt.set(row.appId, now)
      try {
        await deployments.ingestDeployments(row.appId, row.app)
      } catch (e) {
        logOnce(row.id, 'ingest', `deploy journal ingest failed: ${errorText(e)}`)
      }
    }
    const deploys = await deployments.listDeployments(row.appId, 25)
    const match = matchDeploy(deploys, row)
    if (match !== null) {
      status = {
        ...deployStatus(match),
        // No ingress, no environment to link: `off` and `declared` both leave
        // the deployment URL empty rather than pointing GitHub at a hostname
        // nothing answers on.
        environmentUrl: stageExposed(app.stage)
          ? `https://${effectiveHostname(ctx.site, app.name, app.hostname)}`
          : null,
      }
    } else {
      const newer = await newerDeployed(row, deploys)
      if (newer !== null) {
        status = {
          state: 'inactive',
          description: `Build ${sha7(newer)} deployed before this one did.`,
        }
      } else if (Date.now() - row.updatedAt.getTime() >= DEPLOY_WAIT_MS) {
        status = { state: 'error', description: 'No deploy landed within 30 minutes of the build.' }
      } else {
        return
      }
    }
  }

  const call = await createDeploymentStatus(ctx, repo, deploymentId, { ...status, logUrl })
  if (!call.ok) return recordFailure(ctx, row, 'deployment-status', call)
  await finish(ctx, row)
}

/** The sha of a newer live build of the app whose image has already deployed, if any. */
async function newerDeployed(row: BuildRow, deploys: DeployLike[]): Promise<string | null> {
  const { latestSucceeded } = await import('../../lib/repo/builds')
  const newer = await latestSucceeded(row.appId, row.lane, 'live')
  if (
    newer === undefined ||
    newer.id === row.id ||
    newer.createdAt.getTime() <= row.createdAt.getTime() ||
    newer.digest === null
  ) {
    return null
  }
  const since = (row.startedAt ?? row.createdAt).getTime()
  return deploys.some((d) => d.digest === newer.digest && d.startedAt.getTime() >= since)
    ? newer.sha
    : null
}

/**
 * Which repository to post this build to, by the id the sweep pinned.
 *
 * Never `owner/<app name>`: the app's name is daedalus's key for its own row
 * and a display label everywhere else, and a repository renamed on GitHub
 * keeps that name here — so every check run and Deployment would go to a
 * repository that no longer exists, with nothing to show but a 404 in the log. The id
 * is the one thing a rename does not move, and `repoById` reads today's name
 * off it. Null when GitHub cannot say: the build stays unreported and the next
 * tick asks again, which is the right answer — posting to a guessed name is not.
 */
async function repoRefOf(ctx: Ctx, row: BuildRow): Promise<RepoRef | null> {
  const { getApp } = await import('../../lib/repo/apps')
  const app = await getApp(row.app)
  if (!app || app.githubRepoId === null) {
    logOnce(row.id, 'no-repo-id', `${row.app} has no GitHub repository pinned; nothing was posted`)
    return null
  }
  const { repoById } = await import('../github-app')
  const found = await repoById(ctx, app.githubRepoId)
  if (!found.ok) {
    logOnce(
      row.id,
      `repo-lookup:${found.reason}`,
      `could not read repository ${String(app.githubRepoId)}: ${found.reason}`,
    )
    return null
  }
  return { owner: found.value.owner, repo: found.value.name }
}

async function reportRow(ctx: Ctx, row: BuildRow, manual: boolean): Promise<void> {
  if (row.state === 'queued') return
  if (isTerminalBuildState(row.state) && row.reported) return
  const m = memo()
  if (m.inFlight.has(row.id)) return
  m.inFlight.add(row.id)
  try {
    await failures(ctx)
    // Never handed to the host and never posted: there is nothing to say.
    if (
      (row.state === 'cancelled' || row.state === 'superseded') &&
      row.startedAt === null &&
      (await checkRunIdOf(row, false)) === null
    ) {
      await save(row.id, { reported: true })
      return
    }
    if (!mayCall(row.id, manual)) return

    const site = await siteFacts(ctx)
    if (site.app === null) {
      logOnce(row.id, 'no-app', 'site.json names no GitHub App; nothing was reported')
      return
    }
    const repo = await repoRefOf(ctx, row)
    if (repo === null) return
    if (isActiveBuildState(row.state)) await reportProgress(ctx, row, repo, site)
    else await reportFinal(ctx, row, repo, site)
  } finally {
    m.inFlight.delete(row.id)
  }
}

/** Called by the scheduler whenever a build row's state or phase changed. */
export async function reportBuildChange(ctx: Ctx, row: BuildRow): Promise<void> {
  try {
    await reportRow(ctx, row, false)
  } catch (e) {
    logOnce(row.id, `crash:${errorText(e)}`, `report failed: ${errorText(e)}`)
  }
}

/** Called on every scheduler tick: pending deployment matches, retries. */
export async function reportTick(ctx: Ctx): Promise<void> {
  try {
    const m = memo()
    if (Date.now() - m.lastTickAt < TICK_MIN_INTERVAL_MS) return
    m.lastTickAt = Date.now()
    if (Date.now() < m.blockedUntil) return
    await failures(ctx)
    const { activeBuilds, unreportedBuilds, toBuildRow } = await import('../../lib/repo/builds')

    // Both are list reads: no detection rides along. reportFinal reads the one
    // build it completes whole.
    for (const row of await activeBuilds()) {
      const last = m.sent.get(row.id)
      const pending =
        (row.checkRunId === null && !m.checkRuns.has(row.id)) ||
        last === undefined ||
        ((last.state !== row.state || last.phase !== row.phase) &&
          Date.now() - last.at >= PATCH_MIN_INTERVAL_MS)
      if (pending) await reportRow(ctx, row, false)
    }

    let budget = TICK_BUDGET
    const since = new Date(Date.now() - REPORT_WINDOW_MS)
    for (const record of await unreportedBuilds(since, UNREPORTED_READ)) {
      if (budget <= 0 || Date.now() < m.blockedUntil) break
      const row = toBuildRow(record)
      if (Date.now() - row.updatedAt.getTime() > REPORT_WINDOW_MS) continue
      if (!mayCall(row.id, false)) continue
      budget--
      await reportRow(ctx, row, false)
    }
  } catch (e) {
    logOnce('tick', `crash:${errorText(e)}`, `report tick failed: ${errorText(e)}`)
  }
}

/** "Retry report": forget the failure and report the build now, whatever its retries. */
export async function retryReport(ctx: Ctx, buildId: string): Promise<void> {
  try {
    await clearFailure(ctx, buildId)
    const { getBuild, toBuildRow } = await import('../../lib/repo/builds')
    const record = await getBuild(buildId)
    if (record !== undefined) await reportRow(ctx, toBuildRow(record), true)
  } catch (e) {
    logOnce(buildId, `retry:${errorText(e)}`, `retry failed: ${errorText(e)}`)
  }
}
