// Builds on the box: what GitHub hears about a build — the `daedalus` check run
// and, for live deploys, a Deployment and its statuses (plan step 5).
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
// The builds table has no column for the failure itself, so the record lives
// in the preferences store; GitHub's rate limit and the throttles are
// per-process, on globalThis so a Vite re-evaluation keeps them.

import { detectionFromStatus, railpackSpoke } from '../../lib/build-detect'
import { pushedTags } from '../../lib/build-display'
import type { BuildRow } from '../../lib/build-queue'
import { type BuildState, isActiveBuildState, isTerminalBuildState } from '../../lib/builds'
import { bytes, ms } from '../../lib/format'
import { checkRunOutput } from '../../lib/github-app'
import { effectiveHostname } from '../../lib/hostname'
import type { AppRecord } from '../../lib/repo/apps'
import type { Ctx } from '../ctx'
import {
  type CheckRunConclusion,
  clampChars,
  createCheckRun,
  createDeployment,
  createDeploymentStatus,
  type DeploymentState,
  type GhCall,
  type GhFailure,
  type RepoRef,
  updateCheckRun,
} from '../github-checks'
import type { SiteGithubApp } from '../site/file'

export const PATCH_MIN_INTERVAL_MS = 10_000
export const REPORT_MAX_RETRIES = 3
/** Before retry 1, 2 and 3. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const
/** A live build whose Deployment sees no deploy this long after it finished gets `error`. */
export const DEPLOY_WAIT_MS = 30 * 60_000
/** Older unreported builds are left alone by the tick; retryReport still reaches them. */
export const REPORT_WINDOW_MS = 24 * 60 * 60_000
/** Unreported builds a tick may work on. */
export const TICK_BUDGET = 5
/** Unreported builds a tick reads: newest first, within REPORT_WINDOW_MS. */
export const UNREPORTED_READ = 20
const TICK_MIN_INTERVAL_MS = 5_000
const INGEST_MIN_INTERVAL_MS = 15_000
const TITLE_MAX_CHARS = 200
/** GitHub's ceiling for a check run's `text`. */
export const CHECK_RUN_TEXT_MAX_BYTES = 65_535
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

type Delivery = 'deploy' | 'candidate' | 'pinned'

type Memo = {
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

const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

function mapOf(v: unknown, value: (x: unknown) => boolean): boolean {
  if (!(v instanceof Map)) return false
  for (const [k, x] of v) if (!isStr(k) || !value(x)) return false
  return true
}

function isMemo(v: unknown): v is Memo {
  if (!isRec(v)) return false
  return (
    isFiniteNum(v.blockedUntil) &&
    isFiniteNum(v.lastTickAt) &&
    mapOf(v.sent, (s) => isRec(s) && isFiniteNum(s.at) && isStr(s.state) && isStr(s.phase)) &&
    mapOf(v.checkRuns, isFiniteNum) &&
    mapOf(v.deployments, isFiniteNum) &&
    mapOf(v.completed, isStr) &&
    (v.failures === null ||
      mapOf(
        v.failures,
        (f) =>
          isRec(f) &&
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
function memo(): Memo {
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

function logOnce(id: string, key: string, message: string): void {
  const m = memo()
  const k = `${id}:${key}`
  if (m.logged.has(k)) return
  m.logged.add(k)
  console.warn(`[build-report] ${id.slice(0, 8)} ${message}`)
}

const errorName = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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

async function failures(ctx: Ctx): Promise<Map<string, ReportFailure & { nextAt: number }>> {
  const m = memo()
  if (m.failures !== null) return m.failures
  let stored: ReportFailures = {}
  try {
    stored = (await ctx.store.read(REPORT_FAILURES_KEY, isFailures)) ?? {}
  } catch (e) {
    logOnce('store', 'read', `could not read ${REPORT_FAILURES_KEY}: ${errorName(e)}`)
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
    logOnce('store', 'write', `could not write ${REPORT_FAILURES_KEY}: ${errorName(e)}`)
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

function block(retryAfterMs: number | null): void {
  const m = memo()
  const until = Date.now() + (retryAfterMs ?? 60_000)
  if (until <= m.blockedUntil) return
  m.blockedUntil = until
  console.warn(
    `[build-report] GitHub rate limit: no calls for ${String(Math.ceil((retryAfterMs ?? 60_000) / 1000))} s`,
  )
}

async function recordFailure(
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

async function clearFailure(ctx: Ctx, id: string): Promise<void> {
  const all = await failures(ctx)
  if (!all.delete(id)) return
  await persistFailures(ctx)
}

/** Whether a build's report may call GitHub now. */
function mayCall(id: string, manual: boolean): boolean {
  const m = memo()
  if (Date.now() < m.blockedUntil) return false
  if (manual) return true
  const f = m.failures?.get(id)
  return f === undefined || (!f.gaveUp && Date.now() >= f.nextAt)
}

// ── what the row says ───────────────────────────────────────────────────────

type SiteFacts = {
  app: SiteGithubApp | null
  /** The box's name for titles: site.json `identity.hostname`. */
  box: string
  controlPlane: string | null
}

/** The control plane host as core/settings/github-app.ts derives it. Never a request header. */
async function siteFacts(ctx: Ctx): Promise<SiteFacts> {
  const { readCommittedSite } = await import('../../lib/contract/domains/site-doc')
  const site = await readCommittedSite()
  const doc = site.present ? site.doc : null
  let controlPlane: string | null = null
  if (doc !== null && doc.identity.controlPlane !== '' && doc.identity.baseDomain !== '') {
    controlPlane = `${doc.identity.controlPlane}.${doc.identity.baseDomain}`
  } else {
    const { siteIdentity } = await import('../../lib/contract/domains/site')
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

type AppFacts = Pick<
  AppRecord,
  'id' | 'name' | 'hostname' | 'stage' | 'deployEnable' | 'sourceMode' | 'image'
>

/**
 * Whether a succeeded build is deployed. The status's `pinned` is not kept on
 * the row, so it is read off the app: deploys frozen, a local-source app, or
 * an image override pinned to a digest all leave the build where it is.
 */
export function deliveryOf(row: Pick<BuildRow, 'publish'>, app: AppFacts | null): Delivery {
  if (row.publish === 'candidate') return 'candidate'
  if (app === null || !app.deployEnable || app.sourceMode === 'local') return 'pinned'
  if (app.image?.includes('@sha256:')) return 'pinned'
  return 'deploy'
}

const sha7 = (sha: string): string => sha.slice(0, 7)

function longestRun(s: string, ch: string): number {
  let best = 0
  let run = 0
  for (const c of s) {
    run = c === ch ? run + 1 : 0
    if (run > best) best = run
  }
  return best
}

/** Inline code that survives backticks in the value. */
function code(s: string): string {
  const fence = '`'.repeat(longestRun(s, '`') + 1)
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${s}${pad}${fence}`
}

/** Most resolved tools the summary lists; a plan with more is a plan to read elsewhere. */
const TABLE_MAX_ROWS = 20
/** Most Railpack lines the summary quotes, for the same reason. */
const ADVICE_MAX_LINES = 20

/**
 * One Markdown table cell. A pipe would end the column and a newline the row,
 * so both are neutralised — a version string or a mise source that contained
 * either would otherwise wreck the table around it.
 */
const cell = (s: string): string => s.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim()

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Drop at least `n` bytes from the front, starting on a whole line when there is one. */
function dropHead(s: string, n: number): string {
  const b = encoder.encode(s)
  let start = Math.min(b.length, n)
  const nl = b.indexOf(0x0a, start)
  if (nl !== -1) start = nl + 1
  else while (start < b.length && ((b[start] ?? 0) & 0xc0) === 0x80) start++
  return decoder.decode(b.subarray(start))
}

/**
 * The log as a Markdown code block: GitHub renders a check run's `text`, so
 * the fence is longer than any backtick run inside and nothing in the log can
 * close it. The whole block stays within GitHub's byte limit; a pathological
 * run of backticks costs earlier lines, never the tail.
 */
export function fenceLog(log: string): string {
  let body = log.endsWith('\n') ? log.slice(0, -1) : log
  for (let i = 0; i < 16; i++) {
    const fence = '`'.repeat(Math.max(3, longestRun(body, '`') + 1))
    const block = `${fence}\n${body}\n${fence}`
    const over = encoder.encode(block).length - CHECK_RUN_TEXT_MAX_BYTES
    if (over <= 0) return block
    body = dropHead(body, over)
  }
  return `\`\`\`\n${dropHead(body.replaceAll('`', "'"), 16)}\n\`\`\``
}

const phaseOf = (row: BuildRow): string => (row.phase !== '' ? row.phase : row.state)

function summaryOf(row: BuildRow, delivery: Delivery | null): string {
  const lines: string[] = []
  const strategy = row.resolvedStrategy ?? row.strategy
  lines.push(
    `- Commit ${code(sha7(row.sha))}, requested by ${row.requestedBy}`,
    `- Strategy: ${strategy}${row.strategy === 'auto' && row.resolvedStrategy !== null ? ' (auto)' : ''}`,
    `- Publish: ${row.publish}`,
  )

  if (row.state === 'succeeded' && delivery !== null) {
    lines.push(
      delivery === 'deploy'
        ? '- Result: built, deploying'
        : `- Result: built, not deployed (${delivery})`,
    )
  } else if (row.state === 'failed') {
    lines.push(`- Result: failed${row.error === null ? '' : `: ${row.error}`}`)
  } else if (row.state === 'cancelled' || row.state === 'superseded') {
    lines.push(`- Result: ${phaseOf(row)}`)
  }

  const d = detectionFromStatus(row.detected)
  if (d !== null) {
    const parts = [
      d.provider,
      d.framework,
      d.node === null ? null : `Node ${d.node.version} (${d.node.source})`,
      d.pnpm === null ? null : `pnpm ${d.pnpm.version} (${d.pnpm.source})`,
      d.startCommand === null ? null : `start ${code(d.startCommand)}`,
      d.railpackVersion === null ? null : `Railpack ${d.railpackVersion}`,
    ].filter((p): p is string => p !== null)
    if (parts.length > 0) lines.push(`- Detected: ${parts.join(' · ')}`)
    if (d.aptPackages.length > 0) {
      lines.push(`- Runtime apt packages: ${d.aptPackages.map(code).join(', ')}`)
    }
  }

  if (row.checks !== null) {
    const ran = row.checks.ran.length > 0 ? row.checks.ran.map(code).join(', ') : 'none'
    lines.push(
      `- Checks: ${ran}${row.checks.failed === null ? '' : `; failed: ${code(row.checks.failed)}`}`,
    )
  }

  const timings = Object.entries(row.timings)
  if (timings.length > 0) {
    const total = timings.reduce((sum, [, v]) => sum + v, 0)
    lines.push(
      `- Timings: ${timings.map(([k, v]) => `${k} ${ms(v)}`).join(' · ')} · total ${ms(total)}`,
    )
  }

  if (row.digest !== null) {
    lines.push(`- Image: ${code(row.imageRef ?? row.digest)}`)
    if (row.imageRef !== null && !row.imageRef.includes(row.digest)) {
      lines.push(`- Digest: ${code(row.digest)}`)
    }
    const t = pushedTags(row.publish, row.sha, row.facts?.image?.tags)
    lines.push(`- Tags${t.actual ? '' : ' (expected)'}: ${t.tags.map(code).join(', ')}`)
  }
  // Labelled, because it is the manifest's compressed layers plus its config —
  // what a pull moves, not what the image takes unpacked.
  if (row.sizeBytes !== null) lines.push(`- Pull size: ${bytes(row.sizeBytes)}`)
  const run = row.facts?.run ?? null
  if (run !== null) {
    const parts = [
      run.runner === null ? null : `runner ${run.runner}`,
      run.stepsTotal === null
        ? null
        : `${String(run.stepsCached ?? 0)}/${String(run.stepsTotal)} steps cached`,
      run.cacheImported === null ? null : `cache ${run.cacheImported ? 'imported' : 'cold'}`,
      run.cacheExported === true ? 'cache exported' : null,
    ].filter((p): p is string => p !== null)
    if (parts.length > 0) lines.push(`- Builder: ${parts.join(' · ')}`)
  }

  if (d !== null && d.packages.length > 0) {
    lines.push(
      '',
      '**Tools**',
      '',
      '| tool | version | requested | source |',
      '| --- | --- | --- | --- |',
    )
    for (const p of d.packages.slice(0, TABLE_MAX_ROWS)) {
      lines.push(
        `| ${cell(p.name)} | ${cell(p.version)} | ${cell(p.requested ?? '—')} | ${cell(p.source)} |`,
      )
    }
  }

  if (d !== null) {
    // Railpack's own lines, verbatim. They overlap the warnings on purpose: a
    // reader asking "what did Railpack say" wants the errors and the standing
    // notices too, which the warnings deliberately leave out.
    const spoken = railpackSpoke(d).slice(0, ADVICE_MAX_LINES)
    if (spoken.length > 0) {
      lines.push('', '**Railpack said**', '')
      for (const l of spoken) {
        const docs = l.docsPath === null ? '' : ` (${l.docsPath})`
        lines.push(`- ${l.level}: ${l.message}${docs}`)
      }
    }
  }

  if (row.warnings !== null && row.warnings.length > 0) {
    lines.push('', '**Warnings**', '', ...row.warnings.map((w) => `- ${w.message}`))
  }
  return lines.join('\n')
}

function titleOf(row: BuildRow, site: SiteFacts, delivery: Delivery | null): string {
  let title: string
  switch (row.state) {
    case 'succeeded':
      title =
        delivery === 'deploy' || delivery === null
          ? `Built on ${site.box}`
          : `Built on ${site.box}, not deployed (${delivery})`
      break
    case 'failed':
      title = `Build failed on ${site.box}${row.error === null ? '' : `: ${row.error}`}`
      break
    case 'cancelled':
      title = 'Build cancelled'
      break
    case 'superseded':
      title = row.phase.startsWith('superseded by ')
        ? `Superseded by ${row.phase.slice('superseded by '.length)}`
        : 'Build superseded'
      break
    default:
      title = `Building on ${site.box} — ${phaseOf(row)}`
  }
  return clampChars(title, TITLE_MAX_CHARS)
}

const CONCLUSION: Partial<Record<BuildState, CheckRunConclusion>> = {
  succeeded: 'success',
  failed: 'failure',
  cancelled: 'cancelled',
  superseded: 'cancelled',
}

// ── deploy matching ─────────────────────────────────────────────────────────

export type DeployLike = {
  digest: string
  revision: string | null
  result: string
  httpCode: string | null
  startedAt: Date
}

/**
 * The deploy of this build, from newest-first journal rows: the pushed digest,
 * else the image's revision. Only deploys that started after the build did —
 * an older deploy of the same sha (an Actions-built image, say) is not this one.
 */
export function matchDeploy<D extends DeployLike>(
  deploys: D[],
  build: Pick<BuildRow, 'digest' | 'sha' | 'startedAt' | 'createdAt'>,
): D | null {
  const since = (build.startedAt ?? build.createdAt).getTime()
  const recent = deploys.filter((d) => d.startedAt.getTime() >= since)
  const byDigest = build.digest === null ? undefined : recent.find((d) => d.digest === build.digest)
  return byDigest ?? recent.find((d) => d.revision === build.sha) ?? null
}

function deployStatus(d: DeployLike): { state: DeploymentState; description: string } {
  if (d.result === 'ok') {
    return {
      state: 'success',
      description:
        d.httpCode === 'unverified'
          ? 'Deployed. Not health-checked: the app has no ingress.'
          : `Deployed and answering${d.httpCode ? ` (HTTP ${d.httpCode})` : ''}.`,
    }
  }
  return {
    state: 'failure',
    description: `Deployed, but the health check failed${d.httpCode ? ` (last HTTP ${d.httpCode})` : ''}. The new image is still running.`,
  }
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
      `could not record the report: ${errorName(e)}`,
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

  const conclusion = CONCLUSION[row.state]
  if (conclusion !== undefined && m.completed.get(row.id) !== row.state) {
    const { readBuildLogTail } = await import('../../lib/build-bridge')
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
    if (!call.ok) return recordFailure(ctx, row, 'check-run', call)
    m.completed.set(row.id, row.state)
    m.sent.delete(row.id)
    if (id === null) {
      m.checkRuns.set(row.id, call.value.id)
      await save(row.id, { checkRunId: call.value.id })
    }
  }

  if (row.state === 'succeeded' && delivery === 'deploy') {
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
    return
  }

  await finish(ctx, row)
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
        logOnce(row.id, 'ingest', `deploy journal ingest failed: ${errorName(e)}`)
      }
    }
    const deploys = await deployments.listDeployments(row.appId, 25)
    const match = matchDeploy(deploys, row)
    if (match !== null) {
      status = {
        ...deployStatus(match),
        environmentUrl:
          app.stage === 'off' ? null : `https://${effectiveHostname(app.name, app.hostname)}`,
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
    const repo: RepoRef = { owner: site.app.owner, repo: row.app }
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
    logOnce(row.id, `crash:${errorName(e)}`, `report failed: ${errorName(e)}`)
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
    logOnce('tick', `crash:${errorName(e)}`, `report tick failed: ${errorName(e)}`)
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
    logOnce(buildId, `retry:${errorName(e)}`, `retry failed: ${errorName(e)}`)
  }
}
