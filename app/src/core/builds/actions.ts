import {
  BUILD_PUBLISH_MODES,
  BUILD_SHA_RE,
  BUILD_STRATEGIES,
  type BuildPublish,
  type BuildState,
  type BuildStrategy,
  isActiveBuildState,
  isTerminalBuildState,
} from '../../lib/builds'
import type { Result } from '../../lib/result'

// The two build mutations, once.
//
// Same argument as host/apply-flow.ts and host/update-flow.ts, which this
// follows deliberately: a mutation with more than one door gets ONE
// implementation and the doors become adapters over it. Apply and image-update
// learned that the hard way — two hand-copied bodies that could drift. Build
// now and Cancel had exactly one door until /mcp, and this file is what stops
// the second door from becoming a second body.
//
// What stays with the doors, not here: WHO may call. The button's door checks a
// session against `admins` (core/authz assertAdmin); the MCP tool's door checks
// a scoped token (core/authz assertMachineActor). Both then hand in the actor
// they resolved, because "who is this" is the one question the two doors answer
// differently and everything after it is identical.
//
// `actor` is therefore a parameter and never read from the ambient request:
// an MCP call is not running inside a forward-auth request and has no headers
// to read.

/** The build row the request produced (a queued one when the sha was already in flight). */
export type BuildNowResult = Result<{ id: string; sha: string; existing: boolean }>

export type CancelBuildResult = Result<null>

const orDefault = <T extends string>(allowed: readonly T[], v: string, fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback

/**
 * Build the default branch's tip now. The tip is asked of GitHub, never taken
 * from the caller. Refused for an app whose box builds are off, and for one
 * the sweep has not linked to its repository yet.
 *
 * Always forced: insertOrSupersedeQueued has no "already built" skip (only
 * build-queue.ts `enqueue` does), so asking for a tip that already built
 * builds it again, which is what "Build again" means. A build of the same sha
 * already queued or running is the answer instead of a second one.
 */
export async function buildNow(input: { app: string; actor: string }): Promise<BuildNowResult> {
  const { app, actor } = input

  const { getApp } = await import('../../lib/repo/apps')
  const record = await getApp(app)
  if (!record) return { ok: false, reason: `No app named ${app}.` }
  if (record.managedInNix || record.sourceMode === 'local') {
    return { ok: false, reason: `${app} runs its working tree; there is nothing to build.` }
  }
  if (!record.buildOnBox) {
    return {
      ok: false,
      reason: `Box builds are off for ${app}. Turn on Build on this box in its settings.`,
    }
  }
  if (record.githubRepoId === null) {
    return {
      ok: false,
      reason:
        'Waiting for the sweep to link the repo: the box has not matched this app to a GitHub repository yet.',
    }
  }

  const { makeCtx } = await import('../ctx')
  const { ghApp, describeGhFailure, repoById } = await import('../github-app')
  const ctx = await makeCtx()
  // By id rather than owner/name: the id is what the sweep linked, and it is
  // still right after a rename. The name that comes back is a label.
  const found = await repoById(ctx, record.githubRepoId)
  if (!found.ok) return { ok: false, reason: found.reason }
  const { fullName, defaultBranch: branch } = found.value
  const tip = await ghApp<{ sha?: unknown }>(
    ctx,
    `/repos/${fullName}/commits/${encodeURIComponent(branch)}`,
  )
  if (tip.status !== 200 || tip.body === null) {
    return { ok: false, reason: describeGhFailure(tip) }
  }
  const sha = tip.body.sha
  if (typeof sha !== 'string' || !BUILD_SHA_RE.test(sha)) {
    return { ok: false, reason: `GitHub did not name a commit at the tip of ${branch}.` }
  }

  const { openBuildOf } = await import('../../lib/repo/build-views')
  const open = await openBuildOf(record.id, sha)
  if (open !== undefined) return { ok: true, value: { id: open.id, sha, existing: true } }

  const { insertOrSupersedeQueued } = await import('../../lib/repo/builds')
  const enqueued = await insertOrSupersedeQueued({
    appId: record.id,
    sha,
    strategy: orDefault<BuildStrategy>(BUILD_STRATEGIES, record.buildStrategy, 'auto'),
    publish: orDefault<BuildPublish>(BUILD_PUBLISH_MODES, record.buildPublish, 'live'),
    requestedBy: 'operator',
    actor,
  })
  const { ensureScheduler } = await import('./scheduler')
  ensureScheduler()
  console.info(
    `[builds] ${actor} queued ${app}@${sha.slice(0, 7)} as ${enqueued.row.id}` +
      (enqueued.superseded.length > 0 ? `, superseding ${String(enqueued.superseded.length)}` : ''),
  )
  return { ok: true, value: { id: enqueued.row.id, sha, existing: enqueued.alreadyQueued } }
}

/**
 * Stop a running build.
 *
 * Two writes, host first. The bridge file asks the host to stop the unit, whose
 * reaper publishes a terminal status; the row is then marked `cancelled` here,
 * because the host cannot tell a Cancel from a crash — both reach its reaper as
 * `interrupted` (lib/build-queue.ts CANCELLED_BY_OPERATOR).
 *
 * Marking the row terminal is also what makes the two writes safe in either
 * order: `updateFromStatus` refuses a row that is already final, so a build
 * that finished on its own mid-request keeps its own ending, and the host's
 * `interrupted` landing a moment later cannot overwrite a `cancelled` row
 * (`applyStatus`). Idempotent: a second call re-asks the host for the same
 * thing and finds the row already terminal.
 */
export async function cancelBuild(input: {
  app: string
  id: string
  actor: string
}): Promise<CancelBuildResult> {
  const { app, id, actor } = input

  const { getBuild, updateFromStatus } = await import('../../lib/repo/builds')
  const record = await getBuild(id)
  if (!record || record.app !== app) return { ok: false, reason: 'No such build.' }
  const state = record.state as BuildState
  if (isTerminalBuildState(state)) return { ok: true, value: null }
  if (!isActiveBuildState(state)) {
    return { ok: false, reason: 'This build is still queued — nothing is running to stop.' }
  }

  const { requestBuildCancel } = await import('../../host/build-bridge')
  const { CANCELLED_BY_OPERATOR } = await import('../../lib/build-queue')
  await requestBuildCancel(record.id)
  await updateFromStatus(
    record.id,
    {
      state: 'cancelled',
      phase: 'cancelled',
      error: CANCELLED_BY_OPERATOR,
      updatedAt: new Date(),
    },
    'engine',
  )
  // The actor is in the journal, never on the row: the row's words reach a
  // GitHub check run, and an email address does not belong there.
  console.info(
    `[builds] ${actor} cancelled ${app}@${record.sha.slice(0, 7)} (${record.id}) during ${state}`,
  )
  return { ok: true, value: null }
}
