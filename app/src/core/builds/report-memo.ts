// The build reporter's memory: the per-process memo (GitHub's rate-limit clock,
// the progress throttle, ids created here) and the failure record "Retry
// report" renders.
//
// The builds table has no column for the failure itself, so the record lives
// in the preferences store; GitHub's rate limit and the throttles are
// per-process, on globalThis so a Vite re-evaluation keeps them. Only
// core/builds/report.ts uses this; nothing here calls GitHub.

import type { BuildRow } from '../../lib/build-queue'
import type { BuildState } from '../../lib/builds'
import { isRecord } from '../../lib/is-record'
import { errorText } from '../../lib/redact'
import type { Ctx } from '../ctx'
import type { GhCall, GhFailure } from '../github-checks'

const REPORT_MAX_RETRIES = 3
/** Before retry 1, 2 and 3. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const
const KEEP_FAILURES = 50

/** The preferences-store key holding the failures "Retry report" renders. */
export const REPORT_FAILURES_KEY = 'builds.reportFailures'

export type ReportStep = 'check-run' | 'deployment' | 'deployment-status'

export type ReportFailure = {
  step: ReportStep
  kind: GhFailure
  status: number | null
  attempts: number
  at: string
  /** Retries are spent: only retryReport sends it again. */
  gaveUp: boolean
}

export type ReportFailures = Record<string, ReportFailure>

export type Memo = {
  /** GitHub's rate limit is per installation, so one clock for every call. */
  blockedUntil: number
  lastTickAt: number
  /** The progress last sent per build, and when. */
  sent: Map<string, { at: number; state: BuildState; phase: string }>
  /** Ids created here, for when writing them to the row failed. */
  checkRuns: Map<string, number>
  deployments: Map<string, number>
  /** The state a build's check run was completed with. */
  completed: Map<string, BuildState>
  failures: Map<string, ReportFailure & { nextAt: number }> | null
  logged: Set<string>
  inFlight: Set<string>
  ingestedAt: Map<string, number>
}

// Vite keeps globalThis across saves, so the object under this key may have
// been built by an older version of this module. It is never trusted by its
// key alone: a Memo whose shape changed gets a new key version, and whatever is
// there is shape-checked before use and replaced when it does not match.
const MEMO_KEY = 'daedalusBuildReportV1'

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

function mapOf(v: unknown, value: (x: unknown) => boolean): boolean {
  if (!(v instanceof Map)) return false
  for (const [k, x] of v) if (!isStr(k) || !value(x)) return false
  return true
}

function isMemo(v: unknown): v is Memo {
  if (!isRecord(v)) return false
  return (
    isFiniteNum(v.blockedUntil) &&
    isFiniteNum(v.lastTickAt) &&
    mapOf(v.sent, (s) => isRecord(s) && isFiniteNum(s.at) && isStr(s.state) && isStr(s.phase)) &&
    mapOf(v.checkRuns, isFiniteNum) &&
    mapOf(v.deployments, isFiniteNum) &&
    mapOf(v.completed, isStr) &&
    (v.failures === null ||
      mapOf(
        v.failures,
        (f) =>
          isRecord(f) &&
          isStr(f.step) &&
          isStr(f.kind) &&
          (f.status === null || isFiniteNum(f.status)) &&
          isFiniteNum(f.attempts) &&
          isStr(f.at) &&
          typeof f.gaveUp === 'boolean' &&
          isFiniteNum(f.nextAt),
      )) &&
    v.logged instanceof Set &&
    v.inFlight instanceof Set &&
    mapOf(v.ingestedAt, isFiniteNum)
  )
}

function freshMemo(): Memo {
  return {
    blockedUntil: 0,
    lastTickAt: 0,
    sent: new Map(),
    checkRuns: new Map(),
    deployments: new Map(),
    completed: new Map(),
    failures: null,
    logged: new Set(),
    inFlight: new Set(),
    ingestedAt: new Map(),
  }
}

// The object this module evaluation checked or created. Only this evaluation
// writes to it, so while the key still holds it the check need not run again.
let trusted: Memo | null = null

/** The per-process memo, checked. Never throws: anything unexpected is replaced. */
export function memo(): Memo {
  const g = globalThis as unknown as Record<string, unknown>
  try {
    const current = g[MEMO_KEY]
    if (trusted !== null && current === trusted) return trusted
    if (isMemo(current)) {
      trusted = current
      return current
    }
    if (current !== undefined) console.warn('[build-report] replaced a stale report memo')
  } catch {
    // A getter or proxy under the key: replace it like any other mismatch.
  }
  const fresh = freshMemo()
  trusted = fresh
  try {
    g[MEMO_KEY] = fresh
  } catch {
    // A frozen globalThis: this evaluation keeps its own memo.
  }
  return fresh
}

export function logOnce(id: string, key: string, message: string): void {
  const m = memo()
  const k = `${id}:${key}`
  if (m.logged.has(k)) return
  m.logged.add(k)
  console.warn(`[build-report] ${id.slice(0, 8)} ${message}`)
}

// ── failures ────────────────────────────────────────────────────────────────

function isFailures(v: unknown): v is ReportFailures {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v).every(
    (f) =>
      f !== null &&
      typeof f === 'object' &&
      typeof (f as ReportFailure).kind === 'string' &&
      typeof (f as ReportFailure).attempts === 'number' &&
      typeof (f as ReportFailure).gaveUp === 'boolean',
  )
}

export async function failures(ctx: Ctx): Promise<Map<string, ReportFailure & { nextAt: number }>> {
  const m = memo()
  if (m.failures !== null) return m.failures
  let stored: ReportFailures = {}
  try {
    stored = (await ctx.store.read(REPORT_FAILURES_KEY, isFailures)) ?? {}
  } catch (e) {
    logOnce('store', 'read', `could not read ${REPORT_FAILURES_KEY}: ${errorText(e)}`)
  }
  m.failures = new Map(Object.entries(stored).map(([id, f]) => [id, { ...f, nextAt: 0 }]))
  return m.failures
}

const publicFailure = (f: ReportFailure): ReportFailure => ({
  step: f.step,
  kind: f.kind,
  status: f.status,
  attempts: f.attempts,
  at: f.at,
  gaveUp: f.gaveUp,
})

async function persistFailures(ctx: Ctx): Promise<void> {
  const all = [...(await failures(ctx)).entries()]
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .slice(0, KEEP_FAILURES)
  const value: ReportFailures = Object.fromEntries(all.map(([id, f]) => [id, publicFailure(f)]))
  try {
    if (all.length === 0) await ctx.store.delete(REPORT_FAILURES_KEY)
    else await ctx.store.write(REPORT_FAILURES_KEY, value)
  } catch (e) {
    logOnce('store', 'write', `could not write ${REPORT_FAILURES_KEY}: ${errorText(e)}`)
  }
}

/** What "Retry report" renders: builds whose report failed, newest first by key order. */
export async function readReportFailures(ctx: Ctx): Promise<ReportFailures> {
  try {
    const all = await failures(ctx)
    return Object.fromEntries([...all].map(([id, f]) => [id, publicFailure(f)]))
  } catch {
    return {}
  }
}

export function block(retryAfterMs: number | null): void {
  const m = memo()
  const until = Date.now() + (retryAfterMs ?? 60_000)
  if (until <= m.blockedUntil) return
  m.blockedUntil = until
  console.warn(
    `[build-report] GitHub rate limit: no calls for ${String(Math.ceil((retryAfterMs ?? 60_000) / 1000))} s`,
  )
}

export async function recordFailure(
  ctx: Ctx,
  row: BuildRow,
  step: ReportStep,
  call: Extract<GhCall<unknown>, { ok: false }>,
): Promise<void> {
  if (call.failure === 'rate-limited') {
    block(call.retryAfterMs)
    return
  }
  const all = await failures(ctx)
  const attempts = (all.get(row.id)?.attempts ?? 0) + 1
  const gaveUp = attempts > REPORT_MAX_RETRIES
  const delay = RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length) - 1] ?? 600_000
  all.set(row.id, {
    step,
    kind: call.failure,
    status: call.status,
    attempts,
    at: new Date().toISOString(),
    gaveUp,
    nextAt: Date.now() + delay,
  })
  logOnce(
    row.id,
    `${step}:${call.failure}`,
    `${step} for ${row.app} failed: ${call.failure}` +
      (call.status === null ? '' : ` (HTTP ${String(call.status)})`) +
      (gaveUp ? '; retries spent' : ''),
  )
  await persistFailures(ctx)
}

export async function clearFailure(ctx: Ctx, id: string): Promise<void> {
  const all = await failures(ctx)
  if (!all.delete(id)) return
  await persistFailures(ctx)
}

/** Whether a build's report may call GitHub now. */
export function mayCall(id: string, manual: boolean): boolean {
  const m = memo()
  if (Date.now() < m.blockedUntil) return false
  if (manual) return true
  const f = m.failures?.get(id)
  return f === undefined || (!f.gaveUp && Date.now() >= f.nextAt)
}
