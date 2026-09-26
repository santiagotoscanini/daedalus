// The queue's half of a scheduler tick: cancel what can never build, log what
// waits, and — when nothing is in flight — hand the next queued build to the
// host. Also `enqueueChecked`, the one way the engine itself queues a build.
// The choosing is lib/build-dispatch.ts (pure); this file reads its inputs and
// acts on the plan. Everything with a side effect is imported dynamically.

import { type AppBuildFacts, type DispatchPlan, planDispatch } from '../../lib/build-dispatch'
import { type BuildRow, type EnqueueIntent, enqueue, type SkipReason } from '../../lib/build-queue'
import {
  BUILD_REQUEST_MAX_BYTES,
  type BuildRequest,
  buildRequest,
  buildRequestBytes,
} from '../../lib/builds'
import { errorText } from '../../lib/redact'
import type { Ctx } from '../ctx'
import type { SchedulerState } from './scheduler'
import { logOnce } from './scheduler-log'

/** A request over BUILD_REQUEST_MAX_BYTES is failed with this rather than written. */
export const REQUEST_TOO_LARGE = 'request refused: too large'

type Report = (row: BuildRow) => Promise<void>

type DispatchInputs = {
  queued: BuildRow[]
  apps: Map<string, AppBuildFacts>
  installed: boolean
  /** The apps apps.json offers the host builder; null while a build is in flight. */
  inManifest: Set<string> | null
}

/** Cancel what cannot build; when nothing is in flight, dispatch the next. True when one was. */
export async function settleQueue(
  ctx: Ctx,
  now: Date,
  state: SchedulerState,
  report: Report,
  inFlight: boolean,
): Promise<boolean> {
  const inputs = await readDispatchInputs(ctx, inFlight)
  if (inputs === null) return false
  const plan = planDispatch(inputs.queued, inputs.apps, {
    inManifest: inputs.inManifest,
    installed: inputs.installed,
  })
  await cancelAndLogHeld(plan, now, state, report)
  if (inFlight) return false
  return dispatchNext(plan.next, inputs.apps, now, state, report)
}

/** The queue and what deciding it needs; null when nothing is queued. */
async function readDispatchInputs(ctx: Ctx, inFlight: boolean): Promise<DispatchInputs | null> {
  const repo = await import('../../lib/repo/builds')
  const queued = await repo.queuedBuilds()
  if (queued.length === 0) return null

  const { installationState } = await import('../github-app')
  const { listApps } = await import('../../lib/repo/apps')
  const [installation, records] = await Promise.all([installationState(ctx), listApps()])
  // Only the minter's explicit word: a missing, torn or stale file is not "uninstalled".
  const installed = !(installation.available && installation.data.state === 'not-installed')
  const apps = new Map(records.map((a) => [a.name, a as AppBuildFacts]))
  let inManifest: Set<string> | null = null
  if (!inFlight && installed) {
    const { manifestEntries } = await import('../../host/nix-manifest')
    // apps.json: the registry-mode apps the host builder will accept.
    inManifest = new Set(
      (await manifestEntries())
        .filter((e) => !e.managedInNix && e.sourceMode !== 'local')
        .map((e) => e.name),
    )
  }
  return { queued, apps, installed, inManifest }
}

/** Finish a queued or claimed row the engine gave up on, and report it. */
async function failBuild(
  row: BuildRow,
  patch: { state: 'failed' | 'cancelled'; error: string },
  now: Date,
  report: Report,
): Promise<void> {
  const repo = await import('../../lib/repo/builds')
  const record = await repo.updateFromStatus(
    row.id,
    { ...patch, phase: patch.state, updatedAt: now },
    'engine',
  )
  if (record !== undefined) await report(repo.toBuildRow({ ...record, app: row.app }))
}

async function cancelAndLogHeld(
  plan: DispatchPlan,
  now: Date,
  state: SchedulerState,
  report: Report,
): Promise<void> {
  for (const { row, error } of plan.cancel) {
    console.info(`[builds] ${row.app}: cancelled queued ${row.sha.slice(0, 7)} (${error})`)
    await failBuild(row, { state: 'cancelled', error }, now, report)
  }
  for (const { row, reason } of plan.held) {
    logOnce(state, `held:${row.app}`, `held ${row.sha.slice(0, 7)}: ${reason}`, now.getTime())
  }
}

/** Claim the chosen row and write its request for the host. True when it was written. */
async function dispatchNext(
  row: BuildRow | null,
  apps: Map<string, AppBuildFacts>,
  now: Date,
  state: SchedulerState,
  report: Report,
): Promise<boolean> {
  if (row === null) return false
  const app = apps.get(row.app)
  if (app === undefined || app.githubRepoId === null) return false

  let request: BuildRequest
  try {
    request = buildRequest({
      id: row.id,
      app: row.app,
      sha: row.sha,
      repoId: app.githubRepoId,
      strategy: row.strategy,
      publish: row.publish,
      requestedBy: row.requestedBy,
      at: now,
      buildEnv: { placeholders: app.buildEnvPlaceholders, railpack: app.railpackEnv },
    })
  } catch (e) {
    // Left queued it would be picked again every tick, refused every time.
    console.warn(`[builds] ${row.app}: refused ${row.sha.slice(0, 7)}: ${errorText(e)}`)
    await failBuild(
      row,
      { state: 'failed', error: `request refused: ${errorText(e)}` },
      now,
      report,
    )
    return false
  }
  // Below the host's own ceiling, so an oversized request is failed here with
  // a reason rather than refused there with only a mail.
  const bytes = buildRequestBytes(request)
  if (bytes > BUILD_REQUEST_MAX_BYTES) {
    console.warn(
      `[builds] ${row.app}: refused ${row.sha.slice(0, 7)}: the request is ${String(bytes)} bytes, over ${String(BUILD_REQUEST_MAX_BYTES)}`,
    )
    await failBuild(row, { state: 'failed', error: REQUEST_TOO_LARGE }, now, report)
    return false
  }

  const repo = await import('../../lib/repo/builds')
  const claimed = await repo.claimQueued(row.id, now)
  if (claimed === undefined) return false
  try {
    await (await import('../../host/build-bridge')).requestBuild(request)
    state.pending = { id: row.id, at: now.getTime() }
  } catch (e) {
    console.warn(`[builds] ${row.app}: the build request could not be written: ${errorText(e)}`)
    await failBuild(
      repo.toBuildRow({ ...claimed, app: row.app }),
      { state: 'failed', error: 'the build request could not be written' },
      now,
      report,
    )
    return false
  }
  console.info(`[builds] ${row.app}: dispatched ${row.sha.slice(0, 7)} (${row.id})`)
  await report(repo.toBuildRow({ ...claimed, app: row.app }))
  return true
}

/**
 * Queue a build unless the queue's rules skip it — already running, already
 * queued, the lane's newest success in the same publish mode, or (the sweep
 * asks on its own, and so does a superseded build's tip) a sha whose last
 * build failed or was cancelled.
 */
export async function enqueueChecked(
  intent: EnqueueIntent,
  now: Date,
): Promise<'enqueued' | SkipReason> {
  const repo = await import('../../lib/repo/builds')
  const [active, queued, built, history] = await Promise.all([
    repo.activeBuilds(),
    repo.queuedBuilds(),
    repo.latestSucceeded(intent.appId, intent.lane, intent.publish),
    repo.buildsOfSha(intent.appId, intent.lane, intent.publish, intent.sha),
  ])
  const rows = [
    ...active,
    ...queued,
    ...(built === undefined ? [] : [repo.toBuildRow(built)]),
    ...history,
  ]
  const { result } = enqueue(rows, { ...intent, id: crypto.randomUUID(), at: now })
  if (result.kind === 'skipped') return result.reason
  const { alreadyQueued } = await repo.insertOrSupersedeQueued({
    id: result.row.id,
    appId: intent.appId,
    lane: intent.lane,
    prNumber: intent.prNumber,
    sha: intent.sha,
    strategy: intent.strategy,
    publish: intent.publish,
    requestedBy: intent.requestedBy,
    actor: intent.actor ?? null,
    deliveryId: intent.deliveryId ?? null,
  })
  return alreadyQueued ? 'already-queued' : 'enqueued'
}
