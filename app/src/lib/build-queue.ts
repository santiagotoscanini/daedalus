import type { DetectionWarning } from './build-detect'
import {
  BUILD_STATUS_MAX_AGE_MS,
  type BuildChecks,
  type BuildPublish,
  type BuildRequester,
  type BuildState,
  type BuildStatus,
  type BuildStrategy,
  isActiveBuildState,
  isTerminalBuildState,
} from './builds'

// The build queue's rules, as a pure reducer over build rows. The repository
// (lib/repo/builds.ts) and the scheduler apply the decisions to Postgres; the
// rules live here once so they can be table-tested without a database.
//
// One build runs on the box at a time. Per (app, lane) at most one row is
// `queued` — the partial unique index enforces it — so a newer sha supersedes
// the queued one instead of queueing behind it: that row becomes `superseded`
// and a new row takes its place (the repository does both in one transaction).
// A dispatched row leaves `queued` immediately (`markDispatched`), which is
// what lets the next push queue without touching the build the host is
// already running.

export type BuildLane = 'main' | 'pr'

/** Past this since dispatch, a build is failed whatever its status says. */
export const BUILD_HARD_CAP_MS = 100 * 60_000
export const INTERRUPTED = 'interrupted'
export const TIMED_OUT = 'timed out'

/** The failures reconcile decides on its own, for want of word from the host. */
export const ENGINE_VERDICTS: readonly string[] = [INTERRUPTED, TIMED_OUT]

export type BuildRow = {
  id: string
  appId: string
  /** The app's name — what the manifest and the bridge speak. */
  app: string
  lane: BuildLane
  prNumber: number | null
  sha: string
  /** As requested: `auto` stays `auto`. What the host chose is resolvedStrategy. */
  strategy: BuildStrategy
  resolvedStrategy: Exclude<BuildStrategy, 'auto'> | null
  publish: BuildPublish
  requestedBy: BuildRequester
  actor: string | null
  /** X-GitHub-Delivery of the push that asked, when one did. */
  deliveryId: string | null
  state: BuildState
  phase: string
  error: string | null
  /**
   * The status's `detected` as the host wrote it — `{ info, plan }` or a bare
   * info document — undecoded. Readers decode it with build-detect.ts
   * `detectionFromStatus`, so a Railpack field this engine learns to read
   * later is there in old rows too.
   */
  detected: unknown
  /**
   * A cache, written when the status lands: warnings need the repo's facts,
   * which the reducer does not have, so it never computes or clears them.
   */
  warnings: DetectionWarning[]
  checks: BuildChecks | null
  digest: string | null
  imageRef: string | null
  sizeBytes: number | null
  timings: Record<string, number>
  checkRunId: number | null
  deploymentId: number | null
  /** The final state has been posted to GitHub. */
  reported: boolean
  createdAt: Date
  /** When the request was handed to the host; null while queued. */
  startedAt: Date | null
  updatedAt: Date
}

export type EnqueueRequest = {
  id: string
  appId: string
  app: string
  lane: BuildLane
  prNumber: number | null
  sha: string
  strategy: BuildStrategy
  publish: BuildPublish
  requestedBy: BuildRequester
  actor?: string | null
  deliveryId?: string | null
  at: Date
  /** Build even when this sha already succeeded ("Build again"). */
  force?: boolean
}

/** A build the reducer wants queued; the caller mints the id and time. */
export type EnqueueIntent = Omit<EnqueueRequest, 'id' | 'at' | 'force'>

export type SkipReason = 'already-queued' | 'already-running' | 'already-built' | 'already-failed'

/** How many more tries a sha gets after the engine's own verdict (interrupted, timed out). */
export const ENGINE_VERDICT_RETRIES = 1

export type EnqueueResult =
  | { kind: 'enqueued'; row: BuildRow; superseded: string[] }
  | { kind: 'skipped'; reason: SkipReason; existingId: string }

const sameLane = (row: BuildRow, key: { appId: string; lane: BuildLane }): boolean =>
  row.appId === key.appId && row.lane === key.lane

const sha7 = (sha: string): string => sha.slice(0, 7)
const ms = (d: Date | number): number => (typeof d === 'number' ? d : d.getTime())

const isEngineVerdict = (r: Pick<BuildRow, 'state' | 'error'>): boolean =>
  r.state === 'failed' && r.error !== null && ENGINE_VERDICTS.includes(r.error)

/**
 * The sha's newest finished build in this lane and publish mode, when it ended
 * `failed` or `cancelled` and the sha must not be tried again unasked. Without
 * this the hourly sweep, and a superseded build's tip, rebuild a broken tip
 * every hour for as long as it is the tip. The engine's own verdicts
 * (interrupted, timed out) say nothing about the commit, so they buy
 * ENGINE_VERDICT_RETRIES more tries, counted by the sha's failed rows that
 * carry one. Null when the sha may be queued. `rows` must include the sha's
 * past builds (lib/repo/builds.ts `buildsOfSha`).
 */
export function failedTip(
  rows: BuildRow[],
  req: Pick<EnqueueRequest, 'appId' | 'lane' | 'sha' | 'publish'>,
): BuildRow | null {
  const ofSha = rows
    .filter(
      (r) =>
        sameLane(r, req) &&
        r.sha === req.sha &&
        r.publish === req.publish &&
        isTerminalBuildState(r.state),
    )
    .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
  const newest = ofSha[0]
  if (newest === undefined || (newest.state !== 'failed' && newest.state !== 'cancelled')) {
    return null
  }
  if (isEngineVerdict(newest) && ofSha.filter(isEngineVerdict).length <= ENGINE_VERDICT_RETRIES) {
    return null
  }
  return newest
}

/**
 * Why a build of this sha need not be queued, or null — the one skip rule every
 * door shares (webhook, sweep, a superseded build's tip). `rows` is whatever the
 * caller holds of the lane: its active and queued rows, its newest success in
 * this publish mode, and — for the sweep — the sha's own past builds. `force`
 * ("Build now") lifts the built and failed rules.
 *
 * The failed rule binds only the `sweep` requester (the hourly sweep and a
 * superseded build's tip ask on their own). A push is somebody asking: a push
 * of a sha that failed builds it again, and so does Build now.
 */
export function enqueueSkip(
  rows: BuildRow[],
  req: Pick<EnqueueRequest, 'appId' | 'lane' | 'sha' | 'publish' | 'requestedBy' | 'force'>,
): { reason: SkipReason; existingId: string } | null {
  const lane = rows.filter((r) => sameLane(r, req))

  const running = lane.find((r) => isActiveBuildState(r.state) && r.sha === req.sha)
  if (running) return { reason: 'already-running', existingId: running.id }
  const queued = lane.find((r) => r.state === 'queued' && r.sha === req.sha)
  if (queued) return { reason: 'already-queued', existingId: queued.id }
  if (!req.force) {
    // The newest success, with the same publish mode: a candidate build of a
    // sha is not the live build of it.
    const lastBuilt = lane
      .filter((r) => r.state === 'succeeded' && r.publish === req.publish)
      .sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0]
    if (lastBuilt?.sha === req.sha) return { reason: 'already-built', existingId: lastBuilt.id }
    if (req.requestedBy === 'sweep') {
      const failed = failedTip(lane, req)
      if (failed !== null) return { reason: 'already-failed', existingId: failed.id }
    }
  }
  return null
}

export function enqueue(
  rows: BuildRow[],
  req: EnqueueRequest,
): { rows: BuildRow[]; result: EnqueueResult } {
  const skip = enqueueSkip(rows, req)
  if (skip !== null) return { rows, result: { kind: 'skipped', ...skip } }

  const superseded: string[] = []
  const next = rows.map((r) => {
    if (!sameLane(r, req) || r.state !== 'queued') return r
    superseded.push(r.id)
    return {
      ...r,
      state: 'superseded' as const,
      phase: `superseded by ${sha7(req.sha)}`,
      updatedAt: req.at,
    }
  })
  const row: BuildRow = {
    id: req.id,
    appId: req.appId,
    app: req.app,
    lane: req.lane,
    prNumber: req.prNumber,
    sha: req.sha,
    strategy: req.strategy,
    resolvedStrategy: null,
    publish: req.publish,
    requestedBy: req.requestedBy,
    actor: req.actor ?? null,
    deliveryId: req.deliveryId ?? null,
    state: 'queued',
    phase: '',
    error: null,
    detected: null,
    warnings: [],
    checks: null,
    digest: null,
    imageRef: null,
    sizeBytes: null,
    timings: {},
    checkRunId: null,
    deploymentId: null,
    reported: false,
    createdAt: req.at,
    startedAt: null,
    updatedAt: req.at,
  }
  return { rows: [...next, row], result: { kind: 'enqueued', row, superseded } }
}

export type HeldBuild = { row: BuildRow; reason: string }

export type NextBuild = {
  row: BuildRow | null
  /** Queued rows that cannot run yet, with why — shown on the builds board. */
  held: HeldBuild[]
  blockedBy: 'in-flight' | null
}

const laneRank = (lane: BuildLane): number => (lane === 'main' ? 0 : 1)

export function nextToRun(
  rows: BuildRow[],
  opts: { inManifest: Set<string>; inFlight: boolean },
): NextBuild {
  const queued = rows
    .filter((r) => r.state === 'queued')
    .sort(
      (a, b) =>
        laneRank(a.lane) - laneRank(b.lane) ||
        ms(a.createdAt) - ms(b.createdAt) ||
        a.id.localeCompare(b.id),
    )
  const held: HeldBuild[] = []
  const runnable: BuildRow[] = []
  for (const r of queued) {
    if (opts.inManifest.has(r.app)) runnable.push(r)
    else {
      held.push({
        row: r,
        reason: `${r.app} is not in the applied app manifest yet; it builds once Apply lands.`,
      })
    }
  }
  if (opts.inFlight || rows.some((r) => isActiveBuildState(r.state))) {
    return { row: null, held, blockedBy: 'in-flight' }
  }
  return { row: runnable[0] ?? null, held, blockedBy: null }
}

/** The row as handed to the host: out of `queued`, so the lane can queue again. */
export function markDispatched<R extends BuildRow>(row: R, now: Date): R {
  return { ...row, state: 'cloning', phase: 'requested', startedAt: now, updatedAt: now }
}

/**
 * Whether the host's status may replace a finished row. The host is the source
 * of truth, so exactly one kind of finished row is not final: a `failed` the
 * engine decided for want of word (interrupted, timed out), replaced by a
 * terminal status from the host that says something different. "Different",
 * because the status file is re-read on every tick and the same answer must
 * not be reported twice.
 */
export function hostOverridesVerdict(
  row: Pick<BuildRow, 'state' | 'error'>,
  status: Pick<BuildStatus, 'state' | 'error'>,
): boolean {
  return (
    row.state === 'failed' &&
    row.error !== null &&
    ENGINE_VERDICTS.includes(row.error) &&
    isTerminalBuildState(status.state) &&
    (status.state !== row.state || status.error !== row.error)
  )
}

/**
 * Fold the host's status into its row. A status for another id is ignored. A
 * finished row is final unless `hostOverridesVerdict`; then the host's word
 * replaces the engine's and `reported` drops, so the reporter posts it again.
 * The host's `queued` keeps the row in flight rather than putting it back in
 * the queue. The requested strategy is never overwritten. `detected` is kept
 * raw; a status without one keeps the row's.
 */
export function applyStatus<R extends BuildRow>(row: R, status: BuildStatus | null): R {
  if (status === null || status.id !== row.id) return row
  const overrides = hostOverridesVerdict(row, status)
  if (isTerminalBuildState(row.state) && !overrides) return row

  const state: BuildState =
    status.state === 'queued' ? (row.state === 'queued' ? 'cloning' : row.state) : status.state
  const heard = Date.parse(status.updatedAt)
  const updatedAt = Number.isFinite(heard) ? new Date(heard) : row.updatedAt

  return {
    ...row,
    state,
    phase: status.phase,
    resolvedStrategy: status.strategy === 'auto' ? row.resolvedStrategy : status.strategy,
    error: status.error,
    digest: status.digest ?? row.digest,
    imageRef: status.imageRef ?? row.imageRef,
    sizeBytes: status.sizeBytes ?? row.sizeBytes,
    detected: status.detected ?? row.detected,
    checks: status.checks ?? row.checks,
    timings: Object.keys(status.timings).length > 0 ? status.timings : row.timings,
    reported: overrides ? false : row.reported,
    startedAt: row.startedAt ?? updatedAt,
    updatedAt,
  }
}

/**
 * One scheduler tick's bookkeeping: apply the status, then fail what can no
 * longer finish. A running row whose status (or, before the host has written
 * one, whose dispatch) is older than 90 s was interrupted; one past the hard
 * cap timed out. A row the host just marked `superseded` with a `tip` yields an
 * intent to build that tip — `enqueue` makes it a no-op if already built. Only
 * a row the status actually moved to `superseded`: a final row the status
 * cannot touch yields nothing, however often the file is re-read.
 */
export function reconcile<R extends BuildRow>(
  rows: R[],
  status: BuildStatus | null,
  now: Date | number,
): { rows: R[]; intents: EnqueueIntent[]; changed: string[] } {
  const at = ms(now)
  const intents: EnqueueIntent[] = []
  const changed: string[] = []

  const next = rows.map((row) => {
    let r = applyStatus(row, status)

    if (
      status !== null &&
      status.id === row.id &&
      r.state === 'superseded' &&
      row.state !== 'superseded' &&
      status.tip !== null &&
      status.tip !== row.sha
    ) {
      intents.push({
        appId: row.appId,
        app: row.app,
        lane: row.lane,
        prNumber: row.prNumber,
        sha: status.tip,
        strategy: row.strategy,
        publish: row.publish,
        requestedBy: row.requestedBy,
      })
    }

    if (isActiveBuildState(r.state)) {
      const started = ms(r.startedAt ?? r.createdAt)
      if (at - started > BUILD_HARD_CAP_MS) {
        r = { ...r, state: 'failed', error: TIMED_OUT, updatedAt: new Date(at) }
      } else if (at - ms(r.updatedAt) > BUILD_STATUS_MAX_AGE_MS) {
        r = { ...r, state: 'failed', error: INTERRUPTED, updatedAt: new Date(at) }
      }
    }

    if (r !== row) changed.push(row.id)
    return r
  })

  return { rows: next, intents, changed }
}
