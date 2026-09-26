// The words of a build's GitHub report: the check run's title, its Markdown
// summary and fenced log, and the Deployment status a deploy earns — plus which
// deploy is this build's. Pure, so the renderer is tested without GitHub;
// core/builds/report.ts decides when to post them and to where.

import type { CheckRunConclusion, DeploymentState } from '../core/github-checks'
import { type Detection, detectionFromStatus, railpackSpoke } from './build-detect'
import { pushedTags } from './build-display'
import type { BuildRow } from './build-queue'
import type { BuildState } from './builds'
import { bytes, ms } from './format'
import type { AppRecord } from './repo/apps'

/** GitHub's ceiling for a check run's `text`. */
export const CHECK_RUN_TEXT_MAX_BYTES = 65_535

export type Delivery = 'deploy' | 'candidate' | 'pinned'

export type AppFacts = Pick<
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

export const sha7 = (sha: string): string => sha.slice(0, 7)

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
export function code(s: string): string {
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
export const cell = (s: string): string => s.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim()

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Drop at least `n` bytes from the front, starting on a whole line when there is one. */
export function dropHead(s: string, n: number): string {
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

// ── the summary, one builder per paragraph of it ────────────────────────────

function headerLines(row: BuildRow): string[] {
  const strategy = row.resolvedStrategy ?? row.strategy
  return [
    `- Commit ${code(sha7(row.sha))}, requested by ${row.requestedBy}`,
    `- Strategy: ${strategy}${row.strategy === 'auto' && row.resolvedStrategy !== null ? ' (auto)' : ''}`,
    `- Publish: ${row.publish}`,
  ]
}

function resultLine(row: BuildRow, delivery: Delivery | null): string[] {
  if (row.state === 'succeeded' && delivery !== null) {
    return [
      delivery === 'deploy'
        ? '- Result: built, deploying'
        : `- Result: built, not deployed (${delivery})`,
    ]
  }
  if (row.state === 'failed') {
    return [`- Result: failed${row.error === null ? '' : `: ${row.error}`}`]
  }
  if (row.state === 'cancelled' || row.state === 'superseded') {
    return [`- Result: ${phaseOf(row)}`]
  }
  return []
}

function detectedLines(d: Detection | null): string[] {
  if (d === null) return []
  const lines: string[] = []
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
  return lines
}

function checksLine(row: BuildRow): string[] {
  if (row.checks === null) return []
  const ran = row.checks.ran.length > 0 ? row.checks.ran.map(code).join(', ') : 'none'
  return [
    `- Checks: ${ran}${row.checks.failed === null ? '' : `; failed: ${code(row.checks.failed)}`}`,
  ]
}

function timingsLine(row: BuildRow): string[] {
  const timings = Object.entries(row.timings)
  if (timings.length === 0) return []
  const total = timings.reduce((sum, [, v]) => sum + v, 0)
  return [`- Timings: ${timings.map(([k, v]) => `${k} ${ms(v)}`).join(' · ')} · total ${ms(total)}`]
}

function imageLines(row: BuildRow): string[] {
  const lines: string[] = []
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
  return lines
}

function builderLine(row: BuildRow): string[] {
  const run = row.facts?.run ?? null
  if (run === null) return []
  const parts = [
    run.runner === null ? null : `runner ${run.runner}`,
    run.stepsTotal === null
      ? null
      : `${String(run.stepsCached ?? 0)}/${String(run.stepsTotal)} steps cached`,
    run.cacheImported === null ? null : `cache ${run.cacheImported ? 'imported' : 'cold'}`,
    run.cacheExported === true ? 'cache exported' : null,
  ].filter((p): p is string => p !== null)
  return parts.length > 0 ? [`- Builder: ${parts.join(' · ')}`] : []
}

function toolsTable(d: Detection | null): string[] {
  if (d === null || d.packages.length === 0) return []
  return [
    '',
    '**Tools**',
    '',
    '| tool | version | requested | source |',
    '| --- | --- | --- | --- |',
    ...d.packages
      .slice(0, TABLE_MAX_ROWS)
      .map(
        (p) =>
          `| ${cell(p.name)} | ${cell(p.version)} | ${cell(p.requested ?? '—')} | ${cell(p.source)} |`,
      ),
  ]
}

function railpackLines(d: Detection | null): string[] {
  if (d === null) return []
  // Railpack's own lines, verbatim. They overlap the warnings on purpose: a
  // reader asking "what did Railpack say" wants the errors and the standing
  // notices too, which the warnings deliberately leave out.
  const spoken = railpackSpoke(d).slice(0, ADVICE_MAX_LINES)
  if (spoken.length === 0) return []
  return [
    '',
    '**Railpack said**',
    '',
    ...spoken.map(
      (l) => `- ${l.level}: ${l.message}${l.docsPath === null ? '' : ` (${l.docsPath})`}`,
    ),
  ]
}

function warningLines(row: BuildRow): string[] {
  if (row.warnings === null || row.warnings.length === 0) return []
  return ['', '**Warnings**', '', ...row.warnings.map((w) => `- ${w.message}`)]
}

/** The check run's Markdown summary. `delivery` is null until the build succeeded. */
export function summaryOf(row: BuildRow, delivery: Delivery | null): string {
  const d = detectionFromStatus(row.detected)
  return [
    ...headerLines(row),
    ...resultLine(row, delivery),
    ...detectedLines(d),
    ...checksLine(row),
    ...timingsLine(row),
    ...imageLines(row),
    ...builderLine(row),
    ...toolsTable(d),
    ...railpackLines(d),
    ...warningLines(row),
  ].join('\n')
}

/** The check run's title, before GitHub's length clamp. `box` is the site's hostname. */
export function titleText(row: BuildRow, box: string, delivery: Delivery | null): string {
  switch (row.state) {
    case 'succeeded':
      return delivery === 'deploy' || delivery === null
        ? `Built on ${box}`
        : `Built on ${box}, not deployed (${delivery})`
    case 'failed':
      return `Build failed on ${box}${row.error === null ? '' : `: ${row.error}`}`
    case 'cancelled':
      // The row's own words when it has them ("cancelled by the operator"):
      // a cancel somebody asked for and one the queue decided on its own are
      // different events, and the check run is where that difference is read.
      return row.error === null ? 'Build cancelled' : `Build ${row.error}`
    case 'superseded':
      return row.phase.startsWith('superseded by ')
        ? `Superseded by ${row.phase.slice('superseded by '.length)}`
        : 'Build superseded'
    default:
      return `Building on ${box} — ${phaseOf(row)}`
  }
}

export const CONCLUSION: Partial<Record<BuildState, CheckRunConclusion>> = {
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

/** The Deployment status a matched deploy earns. */
export function deployStatus(d: DeployLike): { state: DeploymentState; description: string } {
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
