import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from 'drizzle-orm'
import type { DetectionWarning } from '../build-detect'
import { type BuildLane, type BuildRow, ENGINE_VERDICTS } from '../build-queue'
import {
  ACTIVE_BUILD_STATES,
  type BuildChecks,
  type BuildPublish,
  type BuildRequester,
  type BuildState,
  type BuildStrategy,
  isTerminalBuildState,
  TERMINAL_BUILD_STATES,
} from '../builds'
import { db, type Executor, type Tx } from '../db'
import { apps, builds } from '../schema'

// Build history for the box's own builder. This module only persists: the
// queue's rules are lib/build-queue.ts, the vocabulary is lib/builds.ts.

export type BuildRecord = typeof builds.$inferSelect

/** A row with its app's name — the manifest and the host bridge are keyed by name. */
export type BuildRecordWithApp = BuildRecord & { app: string }

// The jsonb columns a build grows large in: `detected` alone may be 256 KiB
// (host/build.sh MAX_DETECTED_BYTES). Every read that returns many rows or runs
// on the scheduler's tick, and every write's RETURNING, leaves them out;
// getBuild is the one read that carries them.
type HeavyColumn = 'detected' | 'checks' | 'timings' | 'warnings'

const {
  detected: _detected,
  checks: _checks,
  timings: _timings,
  warnings: _warnings,
  ...listColumns
} = getTableColumns(builds)

/** Every builds column but detected, checks, timings and warnings. */
export const BUILD_LIST_COLUMNS = listColumns

export type BuildListRecord = Omit<BuildRecord, HeavyColumn>
export type BuildListRecordWithApp = BuildListRecord & { app: string }

export type BuildRequest = {
  /** The id build-queue minted for the row, when it did; otherwise the database mints one. */
  id?: string
  appId: string
  /** 'main' in v1. */
  lane?: BuildLane
  prNumber?: number | null
  sha: string
  /** As requested — what the host resolved lands in resolvedStrategy. */
  strategy: BuildStrategy
  publish?: BuildPublish
  requestedBy: BuildRequester
  actor?: string | null
  deliveryId?: string | null
}

export type Enqueued = {
  row: BuildRecord
  superseded: BuildRecord[]
  /** The lane's queued row already had this sha: `row` is it, untouched, and nothing was inserted. */
  alreadyQueued: boolean
}

const QUEUED_LANE_INDEX = 'builds_one_queued_per_lane'

/** A unique violation on the one-queued-per-lane index, however deep drizzle wrapped it. */
export function isQueuedLaneConflict(err: unknown): boolean {
  let e: unknown = err
  for (let depth = 0; depth < 5 && typeof e === 'object' && e !== null; depth++) {
    const { code, constraint_name: constraint } = e as { code?: unknown; constraint_name?: unknown }
    if (code === '23505' && constraint === QUEUED_LANE_INDEX) return true
    e = (e as { cause?: unknown }).cause
  }
  return false
}

async function supersedeThenInsert(tx: Tx, input: BuildRequest): Promise<Enqueued> {
  const now = new Date()
  const lane = input.lane ?? 'main'
  const queuedInLane = and(
    eq(builds.appId, input.appId),
    eq(builds.lane, lane),
    eq(builds.state, 'queued'),
  )
  // The same sha already waiting is the answer, not something to supersede:
  // otherwise a replayed or doubled request marks the row "superseded by" its
  // own sha. Locked, so a concurrent claim or supersede cannot move it between
  // this read and the return.
  const [waiting] = await tx.select().from(builds).where(queuedInLane).limit(1).for('update')
  if (waiting !== undefined && waiting.sha === input.sha) {
    return { row: waiting, superseded: [], alreadyQueued: true }
  }
  const superseded = await tx
    .update(builds)
    .set({ state: 'superseded', phase: `superseded by ${input.sha.slice(0, 7)}`, updatedAt: now })
    .where(queuedInLane)
    .returning()
  const [row] = await tx
    .insert(builds)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      appId: input.appId,
      lane,
      prNumber: input.prNumber ?? null,
      sha: input.sha,
      strategy: input.strategy,
      publish: input.publish ?? 'live',
      requestedBy: input.requestedBy,
      actor: input.actor ?? null,
      deliveryId: input.deliveryId ?? null,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
  if (!row) throw new Error(`queueing a build for ${input.appId} returned no row`)
  return { row, superseded, alreadyQueued: false }
}

/**
 * Queue a build, superseding the lane's queued one — build-queue.ts `enqueue`'s
 * decision, applied. The old row becomes `superseded` and the new row is
 * inserted in one transaction (a savepoint, inside a caller's transaction), so
 * both land or neither does. When the queued row already has this sha it is
 * returned as it is (`alreadyQueued`).
 *
 * The partial unique index is what holds under concurrency. Two enqueues for a
 * lane can both find nothing to supersede; the second INSERT then waits on the
 * first's uncommitted row and fails with a unique violation once it commits.
 * Retried once, the UPDATE sees that row and supersedes it. The savepoint is
 * what lets that retry happen without aborting a caller's transaction — the
 * webhook's delivery insert survives it.
 */
export async function insertOrSupersedeQueued(
  input: BuildRequest,
  exec: Executor = db,
): Promise<Enqueued> {
  const attempt = () => exec.transaction((tx) => supersedeThenInsert(tx, input))
  try {
    return await attempt()
  } catch (err) {
    if (!isQueuedLaneConflict(err)) throw err
    return attempt()
  }
}

// Fresh builders per read: drizzle's query builders are single-use.
const withApp = () =>
  db
    .select({ ...getTableColumns(builds), app: apps.name })
    .from(builds)
    .innerJoin(apps, eq(apps.id, builds.appId))

const listWithApp = () =>
  db
    .select({ ...BUILD_LIST_COLUMNS, app: apps.name })
    .from(builds)
    .innerJoin(apps, eq(apps.id, builds.appId))

/**
 * A row in the queue reducer's shape (build-queue.ts `BuildRow`).
 *
 * The table is looser than the reducer on purpose — nullable phase, timings
 * and warnings, text enums — and this is the one place that tightens it. The
 * casts are sound because this module is the only writer and its inputs are
 * typed.
 *
 * A list record (every read but getBuild) has no detected, checks, timings or
 * warnings, so its row reads as none of them. Such a row is for deciding and
 * displaying; nothing may write those four fields back from it.
 */
export function toBuildRow(
  r: BuildListRecordWithApp & Partial<Pick<BuildRecord, HeavyColumn>>,
): BuildRow {
  return {
    id: r.id,
    appId: r.appId,
    app: r.app,
    lane: r.lane as BuildLane,
    prNumber: r.prNumber,
    sha: r.sha,
    strategy: r.strategy as BuildStrategy,
    resolvedStrategy: r.resolvedStrategy as BuildRow['resolvedStrategy'],
    publish: r.publish as BuildPublish,
    requestedBy: r.requestedBy as BuildRequester,
    actor: r.actor,
    deliveryId: r.deliveryId,
    state: r.state as BuildState,
    phase: r.phase ?? '',
    error: r.error,
    // Raw, as the status carried it; decoded on read (detectionFromStatus).
    detected: r.detected ?? null,
    warnings: (r.warnings as DetectionWarning[] | null | undefined) ?? [],
    checks: (r.checks as BuildChecks | null | undefined) ?? null,
    digest: r.digest,
    imageRef: r.imageRef,
    sizeBytes: r.sizeBytes,
    timings: (r.timings as Record<string, number> | null | undefined) ?? {},
    checkRunId: r.checkRunId,
    deploymentId: r.deploymentId,
    reported: r.reported,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One build, whole: the only read that carries detected, checks, timings and warnings. */
export async function getBuild(id: string): Promise<BuildRecordWithApp | undefined> {
  // The id arrives from a URL. A malformed one is "no such build", not a uuid
  // cast error from postgres.
  if (!UUID.test(id)) return undefined
  const [row] = await withApp().where(eq(builds.id, id)).limit(1)
  return row
}

/** The list read, unexecuted: its SQL is what the tests pin. */
export function listBuildsQuery(appId: string, limit = 25) {
  return listWithApp().where(eq(builds.appId, appId)).orderBy(desc(builds.createdAt)).limit(limit)
}

export async function listBuilds(appId: string, limit = 25): Promise<BuildListRecordWithApp[]> {
  return listBuildsQuery(appId, limit)
}

/**
 * The newest successful build of a lane. Pass `publish` for the queue's
 * "already built" check: a candidate build of a sha is not the live build of it.
 */
export async function latestSucceeded(
  appId: string,
  lane: BuildLane = 'main',
  publish?: BuildPublish,
): Promise<BuildListRecordWithApp | undefined> {
  const [row] = await listWithApp()
    .where(
      and(
        eq(builds.appId, appId),
        eq(builds.lane, lane),
        eq(builds.state, 'succeeded'),
        publish === undefined ? undefined : eq(builds.publish, publish),
      ),
    )
    .orderBy(desc(builds.createdAt))
    .limit(1)
  return row
}

/**
 * The lane's builds of one sha in one publish mode, newest first: what
 * build-queue.ts `failedTip` reads to decide whether the sweep may try it again.
 */
export async function buildsOfSha(
  appId: string,
  lane: BuildLane,
  publish: BuildPublish,
  sha: string,
  limit = 10,
): Promise<BuildRow[]> {
  const rows = await listWithApp()
    .where(
      and(
        eq(builds.appId, appId),
        eq(builds.lane, lane),
        eq(builds.publish, publish),
        eq(builds.sha, sha),
      ),
    )
    .orderBy(desc(builds.createdAt))
    .limit(limit)
  return rows.map(toBuildRow)
}

/** Builds handed to the host and not finished — every one, for reconcile. */
export async function activeBuilds(): Promise<BuildRow[]> {
  const rows = await listWithApp()
    .where(inArray(builds.state, [...ACTIVE_BUILD_STATES]))
    .orderBy(asc(builds.createdAt))
  return rows.map(toBuildRow)
}

/** The build the host is working on, if any. v1 runs one at a time. */
export async function runningBuild(): Promise<BuildRow | undefined> {
  return (await activeBuilds())[0]
}

/** Oldest first — queue order. */
export async function queuedBuilds(): Promise<BuildRow[]> {
  const rows = await listWithApp().where(eq(builds.state, 'queued')).orderBy(asc(builds.createdAt))
  return rows.map(toBuildRow)
}

/** The claim, unexecuted: its SQL is what the tests pin. */
export function claimQueuedQuery(id: string, now: Date, exec: Executor = db) {
  return exec
    .update(builds)
    .set({ state: 'cloning', phase: 'requested', startedAt: now, updatedAt: now })
    .where(and(eq(builds.id, id), eq(builds.state, 'queued')))
    .returning(BUILD_LIST_COLUMNS)
}

/**
 * Take a queued build for the host: `queued` → `cloning`, with the hard cap's
 * clock started. Returns the row only when THIS call moved it — a build a
 * concurrent tick claimed, or one superseded or cancelled since it was read,
 * returns undefined, and the scheduler writes the request file only for a row.
 * This is the one way out of `queued`, as insertOrSupersedeQueued is the one
 * way in.
 */
export async function claimQueued(
  id: string,
  now: Date,
  exec: Executor = db,
): Promise<BuildListRecord | undefined> {
  if (!UUID.test(id)) return undefined
  const [row] = await claimQueuedQuery(id, now, exec)
  return row
}

/** Unreported builds a read returns at most; the reporter works five a tick. */
export const UNREPORTED_LIMIT = 20
const UNREPORTED_WINDOW_MS = 24 * 60 * 60_000

/** The unreported read, unexecuted: its SQL is what the tests pin. */
export function unreportedBuildsQuery(since: Date, limit = UNREPORTED_LIMIT) {
  return listWithApp()
    .where(
      and(
        eq(builds.reported, false),
        inArray(builds.state, [...TERMINAL_BUILD_STATES]),
        gte(builds.updatedAt, since),
      ),
    )
    .orderBy(desc(builds.updatedAt))
    .limit(limit)
}

/**
 * Finished builds whose final result has not been posted to GitHub, heard from
 * since `since` (the reporter's 24-hour window), newest first, at most `limit`.
 * Newest first so a pile of builds GitHub keeps refusing cannot starve a fresh
 * one; anything older is reported only by hand (report.ts retryReport).
 */
export async function unreportedBuilds(
  since: Date = new Date(Date.now() - UNREPORTED_WINDOW_MS),
  limit = UNREPORTED_LIMIT,
): Promise<BuildListRecordWithApp[]> {
  return unreportedBuildsQuery(since, limit)
}

/**
 * The fields a status fold may move. `updatedAt` is among them on purpose: it
 * is the last word heard from the host (build-queue's staleness clock), so the
 * caller passes the status's own time rather than the time of the fold.
 *
 * `queued` is not a state it may write: a row enters `queued` only by insert
 * and leaves it only through claimQueued.
 */
export type BuildStatusPatch = Partial<
  Pick<
    typeof builds.$inferInsert,
    | 'phase'
    | 'error'
    | 'detected'
    | 'warnings'
    | 'checks'
    | 'timings'
    | 'digest'
    | 'imageRef'
    | 'sizeBytes'
    | 'startedAt'
    | 'updatedAt'
  > & {
    state: Exclude<BuildState, 'queued'>
    resolvedStrategy: Exclude<BuildStrategy, 'auto'> | null
  }
>

const STATUS_FIELDS = [
  'state',
  'phase',
  'error',
  'resolvedStrategy',
  'detected',
  'warnings',
  'checks',
  'timings',
  'digest',
  'imageRef',
  'sizeBytes',
  'startedAt',
  'updatedAt',
] as const satisfies readonly (keyof BuildStatusPatch)[]

/**
 * Fold a status into the row. `source` says whose word it is: the host's
 * status file, or the engine's own verdict (reconcile's interrupted / timed
 * out, a cancel). Returns the updated row (list columns only), or undefined
 * when there is no such build or the row is final.
 *
 * The rule is build-queue.ts `applyStatus`'s, enforced again in the WHERE so it
 * holds against a concurrent tick: a finished row is final, except an engine
 * verdict that a different terminal word from the host replaces — and then
 * `reported` drops, so the reporter posts the host's answer.
 */
export async function updateFromStatus(
  id: string,
  patch: BuildStatusPatch,
  source: 'host' | 'engine',
): Promise<BuildListRecord | undefined> {
  const clean: BuildStatusPatch = {}
  for (const k of STATUS_FIELDS) {
    if (k in patch) (clean as Record<string, unknown>)[k] = patch[k]
  }

  const open = notInArray(builds.state, [...TERMINAL_BUILD_STATES])
  let where: SQL | undefined = and(eq(builds.id, id), open)
  let reported: SQL | undefined
  const hostFinal =
    source === 'host' && clean.state !== undefined && isTerminalBuildState(clean.state)
      ? clean.state
      : null
  if (hostFinal !== null) {
    const saysSomethingElse =
      clean.error === undefined
        ? ne(builds.state, hostFinal)
        : or(ne(builds.state, hostFinal), sql`${builds.error} is distinct from ${clean.error}`)
    const engineVerdict = and(
      eq(builds.state, 'failed'),
      inArray(builds.error, [...ENGINE_VERDICTS]),
      saysSomethingElse,
    )
    where = and(eq(builds.id, id), or(open, engineVerdict))
    // An open row is never `failed`, so this drops `reported` only on an override.
    reported = sql`case when ${builds.state} = 'failed' then false else ${builds.reported} end`
  }

  const [row] = await db
    .update(builds)
    .set({ updatedAt: new Date(), ...clean, ...(reported === undefined ? {} : { reported }) })
    .where(where)
    .returning(BUILD_LIST_COLUMNS)
  return row
}

/** The pin, unexecuted: its SQL is what the tests pin. */
export function pinGithubRepoIdQuery(appId: string, repoId: number, exec: Executor = db) {
  return exec
    .update(apps)
    .set({ githubRepoId: repoId })
    .where(and(eq(apps.id, appId), isNull(apps.githubRepoId)))
    .returning({ id: apps.id })
}

/**
 * Fill an app's GitHub repository id — only while it is empty, enforced in the
 * WHERE: a pin is never overwritten, however the caller came to disagree with
 * it. True when this call set it. Leaves apps.updatedAt alone: the column is
 * engine-only and the pin is not an edit anyone made.
 */
export async function pinGithubRepoId(appId: string, repoId: number): Promise<boolean> {
  if (!UUID.test(appId) || !Number.isSafeInteger(repoId) || repoId <= 0) return false
  return (await pinGithubRepoIdQuery(appId, repoId)).length > 0
}

/**
 * Record what was posted to GitHub. The ids land as soon as the check run or
 * Deployment exists; `reported` only once the final state has been sent.
 *
 * Does not touch updatedAt: reporting a running build to GitHub is not word
 * from the host, and bumping it would hide a dead one from the staleness check.
 */
export async function markReported(
  id: string,
  report: { checkRunId?: number | null; deploymentId?: number | null; reported?: boolean },
): Promise<void> {
  const set: Partial<typeof builds.$inferInsert> = {}
  if (report.checkRunId !== undefined) set.checkRunId = report.checkRunId
  if (report.deploymentId !== undefined) set.deploymentId = report.deploymentId
  if (report.reported !== undefined) set.reported = report.reported
  if (Object.keys(set).length === 0) return
  await db.update(builds).set(set).where(eq(builds.id, id))
}
