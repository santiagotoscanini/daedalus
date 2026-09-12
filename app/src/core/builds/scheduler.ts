// Builds on the box: the driver that moves queued builds to the host build
// agent and folds its status back into the builds table (plan step 5).
//
// One interval per process, started by `ensureScheduler()` from /api/healthz
// (gatus probes it every minute) and the webhook. Each tick: read the host's
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
//
// Server-only in effect: everything with a side effect is imported dynamically.

import {
  applyStatus,
  type BuildRow,
  type EnqueueIntent,
  enqueue,
  hostOverridesVerdict,
  nextToRun,
  reconcile,
  type SkipReason,
} from '../../lib/build-queue'
import {
  BUILD_PUBLISH_MODES,
  BUILD_SHA_RE,
  BUILD_STRATEGIES,
  type BuildPublish,
  type BuildRequest,
  type BuildStatus,
  type BuildStrategy,
  buildRequest,
  isActiveBuildState,
  isTerminalBuildState,
  redactBuildLog,
} from '../../lib/builds'
import type { Ctx } from '../ctx'

/** Tick cadence while a build is dispatched or running. */
export const ACTIVE_TICK_MS = 3_000
/** Tick cadence otherwise; the interval still fires every ACTIVE_TICK_MS and skips. */
export const IDLE_TICK_MS = 30_000
/** A tick or sweep still running after this is presumed hung; the next one takes over. */
export const TICK_TIMEOUT_MS = 5 * 60_000
/** A written request the host has not answered blocks another this long (lib/apply-flow.ts). */
export const PICKUP_MS = 120_000
export const FIRST_SWEEP_MS = 60_000
export const SWEEP_EVERY_MS = 60 * 60_000
const SWEEP_JITTER_MIN_MS = 30_000
const SWEEP_JITTER_SPAN_MS = 60_000
export const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000
/** A failure of one kind is logged at most once per this. */
export const LOG_EVERY_MS = 60 * 60_000
export const BOX_BUILDS_OFF = 'box builds off'

// ── the slot ───────────────────────────────────────────────────────────────

const SLOT_KEY = 'daedalusBuildSchedulerV1'

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
  githubBackoffUntil: number
  logged: Record<string, number>
}

type Slot = {
  handle: unknown
  tick: () => Promise<void>
  state: SchedulerState
}

const g = globalThis as unknown as Record<string, unknown>

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
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

/** Start the scheduler once per process. Idempotent, synchronous and cheap. */
export function ensureScheduler(): void {
  const current = g[SLOT_KEY]
  if (isRecord(current) && current.tick === tick && isState(current.state)) return
  adopt(current, true)
}

/**
 * Take over whatever the slot holds: this module's tick, a new interval in
 * place of the old one, the old state when it still has the right shape.
 * `start` false only re-arms a scheduler that is already running.
 */
function adopt(current: unknown, start: boolean): void {
  const running = isRecord(current) && 'handle' in current
  if (!running && !start) return
  if (running) disarm(current.handle)
  const state = isRecord(current) && isState(current.state) ? current.state : freshState(Date.now())
  const slot: Slot = { handle: arm(), tick, state }
  g[SLOT_KEY] = slot
}

/** Stop and forget the scheduler (tests; a later ensureScheduler starts afresh). */
export function stopScheduler(): void {
  const current = g[SLOT_KEY]
  if (isRecord(current)) disarm(current.handle)
  delete g[SLOT_KEY]
}

// ── logging ────────────────────────────────────────────────────────────────

export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return redactBuildLog(raw.split('\n')[0] ?? '').slice(0, 300)
}

/** Log a failure once per kind per LOG_EVERY_MS. */
export function logOnce(state: SchedulerState, kind: string, message: string, now = Date.now()) {
  const last = state.logged[kind]
  if (isNum(last) && now - last < LOG_EVERY_MS) return
  const keys = Object.keys(state.logged)
  if (keys.length > 200) {
    for (const k of keys) {
      const at = state.logged[k]
      if (!isNum(at) || now - at >= LOG_EVERY_MS) delete state.logged[k]
    }
  }
  state.logged[kind] = now
  console.warn(`[builds] ${message}`)
}

async function quietly(state: SchedulerState, kind: string, work: () => Promise<unknown>) {
  try {
    await work()
  } catch (e) {
    logOnce(state, kind, `${kind} failed: ${errorText(e)}`)
  }
}

// ── the tick ───────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
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
 * One tick's work. Returns whether something is in flight, which sets the
 * cadence of the next one. Exported for the tests; the interval calls `tick`.
 */
export async function runTick(ctx: Ctx, now: Date, state: SchedulerState): Promise<boolean> {
  const bridge = await import('../../lib/build-bridge')
  const repo = await import('../../lib/repo/builds')
  const { reportBuildChange, reportTick } = await import('./report')
  const at = now.getTime()

  const report = (row: BuildRow) => quietly(state, 'report', () => reportBuildChange(ctx, row))

  // (a) the host's word
  const snapshot = await bridge.readBuildStatus()
  if (snapshot.error !== null)
    logOnce(state, 'status-decode', `build status unreadable: ${snapshot.error}`)
  const status = snapshot.available ? snapshot.data : null
  if (status !== null && state.pending?.id === status.id) state.pending = null

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

  // (b) reconcile
  const { rows: next, intents } = reconcile(rows, status, now)
  const supersededHere = new Set<string>()
  for (const [i, before] of rows.entries()) {
    const after = next[i]
    if (
      after === undefined ||
      after === before ||
      after.state === 'queued' ||
      !moved(before, after)
    ) {
      continue
    }
    const hostView = applyStatus(before, status)
    const source =
      after.state === hostView.state && after.error === hostView.error ? 'host' : 'engine'
    const record = await repo.updateFromStatus(
      before.id,
      {
        state: after.state,
        phase: after.phase,
        error: after.error,
        resolvedStrategy: after.resolvedStrategy,
        detected: after.detected,
        checks: after.checks,
        timings: after.timings,
        digest: after.digest,
        imageRef: after.imageRef,
        sizeBytes: after.sizeBytes,
        startedAt: after.startedAt,
        updatedAt: after.updatedAt,
      },
      source,
    )
    // Final, or moved by a concurrent tick: its change is that tick's to report.
    if (record === undefined) continue
    const row = repo.toBuildRow({ ...record, app: before.app })
    if (row.state === 'superseded' && before.state !== 'superseded') {
      supersededHere.add(`${row.appId} ${row.lane}`)
    }
    if (row.state !== before.state || row.phase !== before.phase) await report(row)
  }
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

  // (c) the queue: cancel what cannot build, then dispatch when nothing is in flight
  const hostBusy = status !== null && !snapshot.stale && !isTerminalBuildState(status.state)
  if (state.pending !== null && at - state.pending.at >= PICKUP_MS) state.pending = null
  const inFlight =
    hostBusy || state.pending !== null || next.some((r) => isActiveBuildState(r.state))
  const dispatched = await settleQueue(ctx, now, state, report, inFlight)

  // (d) the reporter's own rounds
  await quietly(state, 'report-tick', () => reportTick(ctx))

  return inFlight || dispatched
}

/** What the scheduler reads of an app. */
export type AppBuildFacts = {
  id: string
  name: string
  buildOnBox: boolean
  githubRepoId: number | null
  buildStrategy: string
  buildPublish: string
  buildEnvPlaceholders: Record<string, string>
  railpackEnv: Record<string, string>
}

/** The minter says the App is not installed (removed or suspended). */
export const NO_INSTALLATION = 'no installation'

export type DispatchPlan = {
  /** Queued rows that can never build as asked, with the error they are cancelled with. */
  cancel: { row: BuildRow; error: string }[]
  /** Queued and waiting, with why — an unpinned repo, or an app not in apps.json yet. */
  held: { row: BuildRow; reason: string }[]
  next: BuildRow | null
}

/**
 * Pure: which queued builds are cancelled, held, and which one runs next.
 * `inManifest` null means "not picking one now" (a build is in flight): the
 * cancellations still apply, and nothing is chosen.
 */
export function planDispatch(
  queued: BuildRow[],
  apps: Map<string, AppBuildFacts>,
  opts: { inManifest: Set<string> | null; installed: boolean },
): DispatchPlan {
  const cancel: DispatchPlan['cancel'] = []
  const held: DispatchPlan['held'] = []
  const candidates: BuildRow[] = []
  for (const row of queued) {
    if (row.state !== 'queued') continue
    const app = apps.get(row.app)
    if (!opts.installed) cancel.push({ row, error: NO_INSTALLATION })
    else if (app === undefined || !app.buildOnBox) cancel.push({ row, error: BOX_BUILDS_OFF })
    else if (app.githubRepoId === null) {
      held.push({
        row,
        reason: `${row.app} has no GitHub repository pinned yet; it builds once the hourly sweep finds a repository named ${row.app}.`,
      })
    } else candidates.push(row)
  }
  if (opts.inManifest === null) return { cancel, held, next: null }
  const pick = nextToRun(candidates, { inManifest: opts.inManifest, inFlight: false })
  return { cancel, held: [...held, ...pick.held], next: pick.row }
}

/** Cancel what cannot build; when nothing is in flight, dispatch the next. True when one was. */
async function settleQueue(
  ctx: Ctx,
  now: Date,
  state: SchedulerState,
  report: (row: BuildRow) => Promise<void>,
  inFlight: boolean,
): Promise<boolean> {
  const repo = await import('../../lib/repo/builds')
  const queued = await repo.queuedBuilds()
  if (queued.length === 0) return false

  const { installationState } = await import('../github-app')
  const { listApps } = await import('../../lib/repo/apps')
  const [installation, records] = await Promise.all([installationState(ctx), listApps()])
  // Only the minter's explicit word: a missing, torn or stale file is not "uninstalled".
  const installed = !(installation.available && installation.data.state === 'not-installed')
  const apps = new Map(records.map((a) => [a.name, a as AppBuildFacts]))
  let inManifest: Set<string> | null = null
  if (!inFlight && installed) {
    const { manifestEntries } = await import('../../lib/nix-manifest')
    // apps.json: the registry-mode apps the host builder will accept.
    inManifest = new Set(
      (await manifestEntries())
        .filter((e) => !e.managedInNix && e.sourceMode !== 'local')
        .map((e) => e.name),
    )
  }
  const plan = planDispatch(queued, apps, { inManifest, installed })

  const fail = async (row: BuildRow, patch: { state: 'failed' | 'cancelled'; error: string }) => {
    const record = await repo.updateFromStatus(
      row.id,
      { ...patch, phase: patch.state, updatedAt: now },
      'engine',
    )
    if (record !== undefined) await report(repo.toBuildRow({ ...record, app: row.app }))
  }

  for (const { row, error } of plan.cancel) {
    console.info(`[builds] ${row.app}: cancelled queued ${row.sha.slice(0, 7)} (${error})`)
    await fail(row, { state: 'cancelled', error })
  }
  for (const { row, reason } of plan.held) {
    logOnce(state, `held:${row.app}`, `held ${row.sha.slice(0, 7)}: ${reason}`, now.getTime())
  }

  if (inFlight) return false
  const row = plan.next
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
    await fail(row, { state: 'failed', error: `request refused: ${errorText(e)}` })
    return false
  }

  const claimed = await repo.claimQueued(row.id, now)
  if (claimed === undefined) return false
  try {
    await (await import('../../lib/build-bridge')).requestBuild(request)
    state.pending = { id: row.id, at: now.getTime() }
  } catch (e) {
    console.warn(`[builds] ${row.app}: the build request could not be written: ${errorText(e)}`)
    await fail(repo.toBuildRow({ ...claimed, app: row.app }), {
      state: 'failed',
      error: 'the build request could not be written',
    })
    return false
  }
  console.info(`[builds] ${row.app}: dispatched ${row.sha.slice(0, 7)} (${row.id})`)
  await report(repo.toBuildRow({ ...claimed, app: row.app }))
  return true
}

/**
 * Queue a build unless the queue's rules skip it — already running, already
 * queued, or the lane's newest success in the same publish mode.
 */
export async function enqueueChecked(
  intent: EnqueueIntent,
  now: Date,
): Promise<'enqueued' | SkipReason> {
  const repo = await import('../../lib/repo/builds')
  const [active, queued, built] = await Promise.all([
    repo.activeBuilds(),
    repo.queuedBuilds(),
    repo.latestSucceeded(intent.appId, intent.lane, intent.publish),
  ])
  const rows = [...active, ...queued, ...(built === undefined ? [] : [repo.toBuildRow(built)])]
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

// ── the sweep ──────────────────────────────────────────────────────────────

export type SweepRecord = {
  at: string
  pinned: string[]
  enqueued: string[]
  /** Why the GitHub half did not run; null when it did. */
  skipped: string | null
}

const strategyOf = (v: string): BuildStrategy =>
  (BUILD_STRATEGIES as readonly string[]).includes(v) ? (v as BuildStrategy) : 'auto'
const publishOf = (v: string): BuildPublish =>
  (BUILD_PUBLISH_MODES as readonly string[]).includes(v) ? (v as BuildPublish) : 'live'

const segments = (s: string): string => s.split('/').map(encodeURIComponent).join('/')

/** Pin repos, enqueue unbuilt HEADs, prune deliveries. Never throws for GitHub. */
export async function runSweep(ctx: Ctx, now: Date, state: SchedulerState): Promise<SweepRecord> {
  const at = now.getTime()
  const record: SweepRecord = { at: now.toISOString(), pinned: [], enqueued: [], skipped: null }

  await quietly(state, 'prune-deliveries', async () => {
    const { pruneDeliveries } = await import('../../lib/repo/github-deliveries')
    const n = await pruneDeliveries(new Date(at - DELIVERY_RETENTION_MS))
    if (n > 0) console.info(`[builds] pruned ${String(n)} webhook deliveries older than 7 days`)
  })

  record.skipped = await sweepGithub(ctx, now, state, record)

  await quietly(state, 'record-sweep', async () => {
    const { SETTING_KEYS } = await import('../../lib/repo/settings')
    await ctx.store.write(SETTING_KEYS.buildsLastSweep, record)
  })
  return record
}

async function sweepGithub(
  ctx: Ctx,
  now: Date,
  state: SchedulerState,
  record: SweepRecord,
): Promise<string | null> {
  const at = now.getTime()
  if (at < state.githubBackoffUntil) return 'rate limited'

  const github = await import('../github-app')
  const { tokenUsable } = await import('../../lib/github-token')
  if (!tokenUsable(await github.installationState(ctx), at)) {
    logOnce(state, 'github:no-token', 'sweep: no usable installation token; GitHub skipped', at)
    return 'no usable installation token'
  }

  const backoff = (retryAfterMs: number | null) => {
    if (retryAfterMs !== null) state.githubBackoffUntil = at + retryAfterMs
  }

  const listed = await github.listInstallationRepos(ctx)
  if (!listed.ok) {
    logOnce(state, 'github:list-repos', `sweep: listing repositories failed: ${listed.reason}`, at)
    backoff(listed.retryAfterMs)
    return listed.reason
  }

  const { listApps } = await import('../../lib/repo/apps')
  const repo = await import('../../lib/repo/builds')
  const byName = new Map(listed.repos.map((r) => [r.name.toLowerCase(), r]))
  const byId = new Map(listed.repos.map((r) => [r.id, r]))
  const apps = (await listApps()).filter((a) => !a.managedInNix && a.sourceMode === 'registry')

  for (const app of apps) {
    let repoId = app.githubRepoId
    const named = byName.get(app.name.toLowerCase())
    if (repoId === null && named !== undefined) {
      if (await repo.pinGithubRepoId(app.id, named.id)) {
        console.info(
          `[builds] pinned ${app.name} to ${named.fullName} (repository id ${String(named.id)})`,
        )
        record.pinned.push(app.name)
        repoId = named.id
      } else {
        // Pinned by someone else between the read and the write: next sweep.
        continue
      }
    } else if (repoId !== null && named !== undefined && named.id !== repoId) {
      logOnce(
        state,
        `pin-mismatch:${app.name}`,
        `${app.name} is pinned to repository id ${String(repoId)}, but ${named.fullName} is ${String(named.id)}; the pin is kept`,
        at,
      )
    }

    if (!app.buildOnBox || repoId === null) continue
    const target = byId.get(repoId)
    if (target === undefined) {
      logOnce(
        state,
        `repo-missing:${app.name}`,
        `sweep: ${app.name}'s repository ${String(repoId)} is not in the installation`,
        at,
      )
      continue
    }

    const [owner = '', name = ''] = target.fullName.split('/')
    const head = await github.ghApp<{ sha?: unknown }>(
      ctx,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${segments(target.defaultBranch)}`,
    )
    const sha = head.status === 200 ? head.body?.sha : undefined
    if (typeof sha !== 'string' || !BUILD_SHA_RE.test(sha)) {
      logOnce(
        state,
        `github:head:${String(head.error ?? head.status)}`,
        `sweep: reading ${target.fullName}'s ${target.defaultBranch} failed: ${github.describeGhFailure(head)}`,
        at,
      )
      if (head.retryAfterMs !== null) {
        backoff(head.retryAfterMs)
        return 'rate limited'
      }
      continue
    }

    const publish = publishOf(app.buildPublish)
    const built = await repo.latestSucceeded(app.id, 'main', publish)
    if (built?.sha === sha) continue
    const outcome = await enqueueChecked(
      {
        appId: app.id,
        app: app.name,
        lane: 'main',
        prNumber: null,
        sha,
        strategy: strategyOf(app.buildStrategy),
        publish,
        requestedBy: 'sweep',
      },
      now,
    )
    if (outcome === 'enqueued') {
      console.info(
        `[builds] sweep: enqueued ${app.name} ${sha.slice(0, 7)} (${target.defaultBranch} HEAD, not built)`,
      )
      record.enqueued.push(app.name)
    }
  }
  return null
}

// A re-evaluation of this file (a Vite save) swaps the running scheduler onto
// this module's tick. It never starts one: that is ensureScheduler's call.
adopt(g[SLOT_KEY], false)
