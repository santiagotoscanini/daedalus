// Builds on the box: the driver that moves queued builds to the host build
// agent and folds its status back into the builds table.
//
// One interval per process, started by `ensureScheduler()` from /api/healthz
// (gatus probes it every minute) and from Build now (actions.ts). Each tick: read the host's
// status and fold it into the running row, fail what can no longer finish,
// dispatch the next queued build when nothing is in flight, then let the
// reporter run. An hourly sweep, out of band, pins apps to their GitHub repos
// and enqueues a default-branch HEAD that no push delivered (tunnel down, a
// lost delivery, a container restart).
//
// Vite re-evaluates this file on every save while the process lives on. So the
// interval, the current tick function and the plain-data state sit on one
// globalThis slot under a key no earlier version used, read as `unknown` and
// shape-checked on every access (core/settings/github-app.ts's finish lock is
// the outage that taught it). A re-evaluation swaps the tick and re-arms the
// interval in place — never a second one — and keeps the busy flag and the
// pickup guard. No closure but `tick` is stored, and nothing awaits the slot.
// When the state's shape changes the key moves on, and the keys earlier
// versions ran under are retired on sight: their interval cleared, their state
// carried over when it still fits.
//
// This file holds the slot, the tick and the fold; the queue's half of a tick
// is dispatch.ts, the sweep is sweep.ts, and neither touches the slot key.
//
// Server-only in effect: everything with a side effect is imported dynamically.

import type { DetectionWarning } from '../../lib/build-detect'
import { readBuildFacts } from '../../lib/build-facts'
import {
  applyStatus,
  type BuildRow,
  type EnqueueIntent,
  hostOverridesVerdict,
  reconcile,
} from '../../lib/build-queue'
import {
  type BuildState,
  type BuildStatus,
  isActiveBuildState,
  isTerminalBuildState,
} from '../../lib/builds'
import { isRecord } from '../../lib/is-record'
import { errorText } from '../../lib/redact'
import type { BuildStatusPatch } from '../../lib/repo/builds'
import type { Ctx } from '../ctx'
import { enqueueChecked, settleQueue } from './dispatch'
import { logOnce, quietly } from './scheduler-log'
import { runSweep } from './sweep'

/** Tick cadence while a build is dispatched or running. */
export const ACTIVE_TICK_MS = 3_000
/** Tick cadence otherwise; the interval still fires every ACTIVE_TICK_MS and skips. */
export const IDLE_TICK_MS = 30_000
/** A tick or sweep still running after this is presumed hung; the next one takes over. */
export const TICK_TIMEOUT_MS = 5 * 60_000
/** A written request the host has not answered blocks another this long (host/flow.ts's, restated). */
export const PICKUP_MS = 120_000
export const FIRST_SWEEP_MS = 60_000
export const SWEEP_EVERY_MS = 60 * 60_000
const SWEEP_JITTER_MIN_MS = 30_000
const SWEEP_JITTER_SPAN_MS = 60_000

// ── the slot ───────────────────────────────────────────────────────────────

const SLOT_KEY = 'daedalusBuildSchedulerV2'
/** Keys earlier versions of this module ran under. */
const RETIRED_SLOT_KEYS = ['daedalusBuildSchedulerV1'] as const

type Hold = { since: number }

export type SchedulerState = {
  startedAt: number
  lastTickAt: number
  /** The last tick found something in flight: tick at ACTIVE_TICK_MS. */
  active: boolean
  busy: Hold | null
  sweeping: Hold | null
  nextSweepAt: number
  /** The last request written and not yet seen in the status file. */
  pending: { id: string; at: number } | null
  /** The status last folded, so an unchanged file does not cost a lookup per tick. */
  seenStatus: string | null
  /**
   * The detection last written, by build and a hash of its JSON: the status
   * carries up to 256 KiB of it on every heartbeat, and it is written only
   * when it changed. Empty after a restart, which costs one write.
   */
  detectedSeen: { id: string; hash: string } | null
  githubBackoffUntil: number
  logged: Record<string, number>
}

type Slot = {
  handle: unknown
  tick: () => Promise<void>
  state: SchedulerState
}

const g = globalThis as unknown as Record<string, unknown>

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isHold = (v: unknown): boolean => v === null || (isRecord(v) && isNum(v.since))

function isState(v: unknown): v is SchedulerState {
  return (
    isRecord(v) &&
    isNum(v.startedAt) &&
    isNum(v.lastTickAt) &&
    typeof v.active === 'boolean' &&
    isHold(v.busy) &&
    isHold(v.sweeping) &&
    isNum(v.nextSweepAt) &&
    (v.pending === null ||
      (isRecord(v.pending) && typeof v.pending.id === 'string' && isNum(v.pending.at))) &&
    (v.seenStatus === null || typeof v.seenStatus === 'string') &&
    (v.detectedSeen === null ||
      (isRecord(v.detectedSeen) &&
        typeof v.detectedSeen.id === 'string' &&
        typeof v.detectedSeen.hash === 'string')) &&
    isNum(v.githubBackoffUntil) &&
    isRecord(v.logged)
  )
}

export function freshState(now: number): SchedulerState {
  return {
    startedAt: now,
    lastTickAt: 0,
    active: false,
    busy: null,
    sweeping: null,
    nextSweepAt: now + FIRST_SWEEP_MS,
    pending: null,
    seenStatus: null,
    detectedSeen: null,
    githubBackoffUntil: 0,
    logged: {},
  }
}

function readSlot(): Slot | null {
  const v = g[SLOT_KEY]
  return isRecord(v) && typeof v.tick === 'function' && isState(v.state) ? (v as Slot) : null
}

// The interval body reads the slot afresh every time, so it always runs the
// newest module's tick. It never throws and never awaits in a way that stalls.
function onInterval(): void {
  try {
    const v = g[SLOT_KEY]
    if (!isRecord(v) || typeof v.tick !== 'function') return
    const run = (v.tick as () => unknown)()
    if (run instanceof Promise) run.catch(() => undefined)
  } catch {
    // a tick is never allowed to take the interval down
  }
}

function arm(): unknown {
  const handle = setInterval(onInterval, ACTIVE_TICK_MS)
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) handle.unref()
  return handle
}

function disarm(handle: unknown): void {
  if (typeof handle === 'number' || (typeof handle === 'object' && handle !== null)) {
    clearInterval(handle as ReturnType<typeof setInterval>)
  }
}

/**
 * An earlier version's state, brought to this shape in place — the same
 * object, so a tick of that version still running shares its busy flag — or
 * null when it does not fit.
 */
function carryState(v: unknown): SchedulerState | null {
  if (!isRecord(v)) return null
  if (!('detectedSeen' in v)) v.detectedSeen = null
  return isState(v) ? v : null
}

/**
 * Stop every scheduler an earlier version of this module left running, and
 * hand back whether one was and the first state that still fits. The slot is
 * deleted before its interval is cleared, so a callback already queued finds
 * nothing to run.
 */
function retireOld(): { running: boolean; state: SchedulerState | null } {
  let running = false
  let state: SchedulerState | null = null
  for (const key of RETIRED_SLOT_KEYS) {
    const old = g[key]
    if (old === undefined) continue
    delete g[key]
    if (!isRecord(old)) continue
    if ('handle' in old) {
      running = true
      disarm(old.handle)
    }
    state ??= carryState(old.state)
  }
  return { running, state }
}

/** Start the scheduler once per process. Idempotent, synchronous and cheap. */
export function ensureScheduler(): void {
  const current = g[SLOT_KEY]
  if (isRecord(current) && current.tick === tick && isState(current.state)) return
  adopt(current, true)
}

/**
 * Take over whatever the slot holds, and whatever an earlier version left: this
 * module's tick, a new interval in place of the old ones, the old state when it
 * still has the right shape. `start` false only re-arms a scheduler that is
 * already running.
 */
function adopt(current: unknown, start: boolean): void {
  const retired = retireOld()
  const here = isRecord(current) && 'handle' in current
  if (!here && !retired.running && !start) return
  if (here) disarm(current.handle)
  const state =
    isRecord(current) && isState(current.state)
      ? current.state
      : (retired.state ?? freshState(Date.now()))
  const slot: Slot = { handle: arm(), tick, state }
  g[SLOT_KEY] = slot
}

/** Stop and forget the scheduler (tests; a later ensureScheduler starts afresh). */
export function stopScheduler(): void {
  const current = g[SLOT_KEY]
  if (isRecord(current)) disarm(current.handle)
  delete g[SLOT_KEY]
  retireOld()
}

// ── the tick ───────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  // An older module instance that outlived a re-evaluation can start its own
  // scheduler again; this one stops it within a tick.
  if (RETIRED_SLOT_KEYS.some((k) => g[k] !== undefined)) retireOld()
  const slot = readSlot()
  if (slot === null) return
  const state = slot.state
  const now = Date.now()

  if (
    now >= state.nextSweepAt &&
    !(state.sweeping && now - state.sweeping.since < TICK_TIMEOUT_MS)
  ) {
    startSweep(state, now)
  }

  if (state.busy && now - state.busy.since < TICK_TIMEOUT_MS) return
  // Interval timers fire a little late, never early: a second of slack keeps
  // an idle tick from slipping to the following interval.
  if (!state.active && now - state.lastTickAt < IDLE_TICK_MS - 1_000) return

  const mine: Hold = { since: now }
  state.busy = mine
  state.lastTickAt = now
  try {
    const { makeCtx } = await import('../ctx')
    state.active = await runTick(await makeCtx(), new Date(now), state)
  } catch (e) {
    logOnce(state, 'tick', `tick failed: ${errorText(e)}`)
  } finally {
    if (state.busy === mine) state.busy = null
  }
}

function startSweep(state: SchedulerState, now: number): void {
  const mine: Hold = { since: now }
  state.sweeping = mine
  state.nextSweepAt =
    now + SWEEP_EVERY_MS + SWEEP_JITTER_MIN_MS + Math.random() * SWEEP_JITTER_SPAN_MS
  void (async () => {
    try {
      const { makeCtx } = await import('../ctx')
      await runSweep(await makeCtx(), new Date(now), state)
    } catch (e) {
      logOnce(state, 'sweep', `sweep failed: ${errorText(e)}`)
    } finally {
      if (state.sweeping === mine) state.sweeping = null
    }
  })()
}

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime())

/** A reconciled row that is not queued: what a fold writes. */
type FoldedRow = BuildRow & { state: Exclude<BuildState, 'queued'> }

/** Whether the reconcile moved this row into something worth a write. */
function needsWrite(before: BuildRow, after: BuildRow | undefined): after is FoldedRow {
  return after !== undefined && after !== before && after.state !== 'queued' && moved(before, after)
}

/** Whether a fold moved anything worth a write. The host bumps updatedAt on every write. */
function moved(a: BuildRow, b: BuildRow): boolean {
  return (
    a.state !== b.state ||
    a.phase !== b.phase ||
    a.error !== b.error ||
    a.resolvedStrategy !== b.resolvedStrategy ||
    a.digest !== b.digest ||
    a.imageRef !== b.imageRef ||
    a.sizeBytes !== b.sizeBytes ||
    ms(a.startedAt) !== ms(b.startedAt) ||
    ms(a.updatedAt) !== ms(b.updatedAt)
  )
}

const statusKey = (s: BuildStatus): string => `${s.id} ${s.state} ${s.phase} ${s.updatedAt}`

/**
 * The build's warnings, computed where the two halves of the evidence meet.
 *
 * The repo's half — start.mjs, the dependency lists, the package manager, the
 * pnpm allowBuilds — was read out of the clone and rides the status; the app's
 * half — a database, the Railpack env, whether anything about the app needs a
 * server — is only in this database. This is the one place that holds both, so
 * it is the one place the rules can run at all, and it is why lib/build-queue.ts
 * never computes them.
 *
 * An app that has since been deleted is judged on Railpack's output alone
 * rather than not judged: the version, SPA and Railpack-advice rules need no
 * app row, and losing them would be a worse answer than a partial one.
 */
async function warningsOf(app: string, status: BuildStatus): Promise<DetectionWarning[] | null> {
  const { appFacts, statusWarnings } = await import('../../lib/build-detect')
  const { getApp } = await import('../../lib/repo/apps')
  const record = await getApp(app)
  return statusWarnings(
    status,
    record ? appFacts(record) : { hasDatabase: false, railpackEnv: {}, registeredAsServer: false },
  )
}

/**
 * One tick's work. Returns whether something is in flight, which sets the
 * cadence of the next one. Exported for the tests; the interval calls `tick`.
 */
export async function runTick(ctx: Ctx, now: Date, state: SchedulerState): Promise<boolean> {
  const { reportBuildChange, reportTick } = await import('./report')
  const report = (row: BuildRow) => quietly(state, 'report', () => reportBuildChange(ctx, row))

  // (a) the host's word
  const { status, stale } = await readHostStatus(state)
  const rows = await rowsToFold(status, state)

  // (b) reconcile
  const { rows: next, intents } = reconcile(rows, status, now)
  const supersededHere = await foldRows(rows, next, status, state, report)
  await enqueueSupersededTips(intents, supersededHere, state, now)

  // (c) the queue: cancel what cannot build, then dispatch when nothing is in flight
  if (state.pending !== null && now.getTime() - state.pending.at >= PICKUP_MS) state.pending = null
  const inFlight = isInFlight(status, stale, next, state)
  const dispatched = await settleQueue(ctx, now, state, report, inFlight)

  // (d) the reporter's own rounds
  await quietly(state, 'report-tick', () => reportTick(ctx))

  return inFlight || dispatched
}

/** The host's status file, or null; a status naming the pending request clears it. */
async function readHostStatus(
  state: SchedulerState,
): Promise<{ status: BuildStatus | null; stale: boolean }> {
  const bridge = await import('../../host/build-bridge')
  const snapshot = await bridge.readBuildStatus()
  if (snapshot.error !== null)
    logOnce(state, 'status-decode', `build status unreadable: ${snapshot.error}`)
  const status = snapshot.available ? snapshot.data : null
  if (status !== null && state.pending?.id === status.id) state.pending = null
  return { status, stale: snapshot.stale }
}

/** The running rows, plus a finished one the status has just answered for. */
async function rowsToFold(status: BuildStatus | null, state: SchedulerState): Promise<BuildRow[]> {
  const repo = await import('../../lib/repo/builds')
  let rows = await repo.activeBuilds()
  const key = status === null ? null : statusKey(status)
  if (status !== null && key !== state.seenStatus && !rows.some((r) => r.id === status.id)) {
    // A finished row the engine failed for want of word, that the host has now
    // answered for (host truth wins).
    const record = await repo.getBuild(status.id)
    if (record !== undefined) {
      const row = repo.toBuildRow(record)
      if (hostOverridesVerdict(row, status)) rows = [...rows, row]
    }
  }
  state.seenStatus = key
  return rows
}

/**
 * Write each row the reconcile moved, and report the ones whose state or phase
 * changed. Returns the `appId lane` keys superseded by this tick's writes.
 */
async function foldRows(
  rows: BuildRow[],
  next: BuildRow[],
  status: BuildStatus | null,
  state: SchedulerState,
  report: (row: BuildRow) => Promise<void>,
): Promise<Set<string>> {
  const supersededHere = new Set<string>()
  for (const [i, before] of rows.entries()) {
    const after = next[i]
    if (!needsWrite(before, after)) continue
    const row = await foldRow(before, after, status, state)
    // Final, or moved by a concurrent tick: its change is that tick's to report.
    if (row === null) continue
    if (row.state === 'superseded' && before.state !== 'superseded') {
      supersededHere.add(`${row.appId} ${row.lane}`)
    }
    if (row.state !== before.state || row.phase !== before.phase) await report(row)
  }
  return supersededHere
}

/** Write one moved row. Null when the write found it final or already moved. */
async function foldRow(
  before: BuildRow,
  after: FoldedRow,
  status: BuildStatus | null,
  state: SchedulerState,
): Promise<BuildRow | null> {
  const repo = await import('../../lib/repo/builds')
  const hostView = applyStatus(before, status)
  const heard = status !== null && hostView !== before
  const source =
    after.state === hostView.state && after.error === hostView.error ? 'host' : 'engine'
  const { patch, seen } = await buildPatch(before, after, heard ? status : null, state)
  const record = await repo.updateFromStatus(before.id, patch, source)
  if (record === undefined) return null
  if (seen !== null) state.detectedSeen = seen
  return repo.toBuildRow({ ...record, app: before.app })
}

/**
 * The write for a moved row: the reconciled fields, plus what `heard` — the
 * status, when it spoke for this row — carries. `seen` is the detection hash
 * to remember once the write lands.
 */
async function buildPatch(
  before: BuildRow,
  after: FoldedRow,
  heard: BuildStatus | null,
  state: SchedulerState,
): Promise<{ patch: BuildStatusPatch; seen: SchedulerState['detectedSeen'] }> {
  const patch: BuildStatusPatch = {
    state: after.state,
    phase: after.phase,
    error: after.error,
    resolvedStrategy: after.resolvedStrategy,
    digest: after.digest,
    imageRef: after.imageRef,
    sizeBytes: after.sizeBytes,
    startedAt: after.startedAt,
    updatedAt: after.updatedAt,
  }
  // Only what the status itself carries. The rows come from a list read,
  // which holds no detection, checks or timings: writing the row's own
  // (empty) values back would erase what an earlier status stored.
  let seen: SchedulerState['detectedSeen'] = null
  if (heard !== null) {
    if (heard.checks !== null) patch.checks = heard.checks
    if (Object.keys(heard.timings).length > 0) patch.timings = heard.timings
    const facts = readBuildFacts(heard)
    if (facts !== null) patch.facts = facts
    if (heard.detected !== null) {
      const { createHash } = await import('node:crypto')
      // The hash covers `repo` as well as `detected`, because the warnings
      // are a function of both: an agent that publishes the repo facts a
      // tick after the detection must still get them judged.
      const hash = createHash('sha256')
        .update(JSON.stringify([heard.detected, heard.repo]))
        .digest('base64')
      if (state.detectedSeen?.id !== before.id || state.detectedSeen.hash !== hash) {
        patch.detected = heard.detected
        patch.warnings = await warningsOf(before.app, heard)
        seen = { id: before.id, hash }
      }
    }
  }
  return { patch, seen }
}

/** Queue the branch tip a build was superseded by, when this tick wrote that. */
async function enqueueSupersededTips(
  intents: EnqueueIntent[],
  supersededHere: Set<string>,
  state: SchedulerState,
  now: Date,
): Promise<void> {
  for (const intent of intents) {
    if (!supersededHere.has(`${intent.appId} ${intent.lane}`)) continue
    await quietly(state, 'enqueue-tip', async () => {
      const outcome = await enqueueChecked({ ...intent, requestedBy: 'sweep' }, now)
      if (outcome === 'enqueued') {
        console.info(
          `[builds] ${intent.app}: enqueued the branch tip ${intent.sha.slice(0, 7)} after a superseded build`,
        )
      }
    })
  }
}

/** A build the host is running, a request it has not picked up, or an active row. */
function isInFlight(
  status: BuildStatus | null,
  stale: boolean,
  next: BuildRow[],
  state: SchedulerState,
): boolean {
  const hostBusy = status !== null && !stale && !isTerminalBuildState(status.state)
  return hostBusy || state.pending !== null || next.some((r) => isActiveBuildState(r.state))
}

// A re-evaluation of this file (a Vite save) swaps the running scheduler onto
// this module's tick, retiring one an earlier key still runs. It never starts
// one: that is ensureScheduler's call.
adopt(g[SLOT_KEY], false)
