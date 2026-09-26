import {
  arrayOf,
  bool,
  type Decoder,
  nullable,
  num,
  obj,
  optional,
  str,
} from '../../../lib/contract/decode'

// The pure half of the Actions page: what GitHub answers, reduced to what the
// boards draw; what a workflow file says about where it runs; what a minute
// costs. Nothing here touches the network — the fetch layer hands these the
// bodies, and the tests hand them fixtures.

/* ── runs and jobs ────────────────────────────────────────────────────── */

export type RunStatus = 'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending' | 'requested'

export type Run = {
  id: number
  /** owner/name */
  repo: string
  /** The workflow's display name, as the run carries it. */
  workflow: string
  workflowId: number
  branch: string | null
  event: string
  status: RunStatus
  conclusion: string | null
  attempt: number
  actor: string | null
  sha: string
  createdAt: string
  startedAt: string | null
  updatedAt: string
  url: string
}

const rawRun = obj({
  id: num,
  name: nullable(str),
  workflow_id: num,
  head_branch: nullable(str),
  event: str,
  status: nullable(str),
  conclusion: nullable(str),
  run_attempt: optional(num, 1),
  head_sha: str,
  created_at: str,
  run_started_at: optional(nullable(str), null),
  updated_at: str,
  html_url: str,
  actor: optional(nullable(obj({ login: str })), null),
  repository: obj({ full_name: str }),
})

export const runDecoder: Decoder<Run> = (v, p) => {
  const r = rawRun(v, p)
  return {
    id: r.id,
    repo: r.repository.full_name,
    workflow: r.name ?? `workflow ${String(r.workflow_id)}`,
    workflowId: r.workflow_id,
    branch: r.head_branch,
    event: r.event,
    status: (r.status ?? 'queued') as RunStatus,
    conclusion: r.conclusion,
    attempt: r.run_attempt,
    actor: r.actor?.login ?? null,
    sha: r.head_sha,
    createdAt: r.created_at,
    startedAt: r.run_started_at,
    updatedAt: r.updated_at,
    url: r.html_url,
  }
}

export const runsPageDecoder = obj({
  total_count: num,
  workflow_runs: arrayOf(runDecoder),
})

export type Job = {
  id: number
  runId: number
  name: string
  status: string
  conclusion: string | null
  startedAt: string | null
  completedAt: string | null
  /** What the job asked for — its `runs-on`, as GitHub echoes it. */
  labels: string[]
  runnerName: string | null
  runnerGroup: string | null
  /** The first step that failed, when one did. */
  failedStep: string | null
  url: string
}

const rawJob = obj({
  id: num,
  run_id: num,
  name: str,
  status: str,
  conclusion: nullable(str),
  started_at: optional(nullable(str), null),
  completed_at: optional(nullable(str), null),
  labels: optional(arrayOf(str), []),
  runner_name: optional(nullable(str), null),
  runner_group_name: optional(nullable(str), null),
  html_url: nullable(str),
  steps: optional(arrayOf(obj({ name: str, conclusion: nullable(str) })), []),
})

export const jobDecoder: Decoder<Job> = (v, p) => {
  const j = rawJob(v, p)
  return {
    id: j.id,
    runId: j.run_id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    startedAt: j.started_at,
    completedAt: j.completed_at,
    labels: j.labels,
    runnerName: j.runner_name,
    runnerGroup: j.runner_group_name,
    failedStep: j.steps.find((s) => s.conclusion === 'failure')?.name ?? null,
    url: j.html_url ?? '',
  }
}

export const jobsPageDecoder = obj({ total_count: num, jobs: arrayOf(jobDecoder) })

export type Workflow = {
  id: number
  name: string
  /** `.github/workflows/agent.yml` */
  path: string
  state: string
  url: string
}

const workflowDecoder: Decoder<Workflow> = (v, p) => {
  const w = obj({ id: num, name: str, path: str, state: str, html_url: str })(v, p)
  return { id: w.id, name: w.name, path: w.path, state: w.state, url: w.html_url }
}

export const workflowsPageDecoder = obj({
  total_count: num,
  workflows: arrayOf(workflowDecoder),
})

/** A directory listing from the contents API, reduced to name, path, type and size. */
export const contentsListDecoder = arrayOf(obj({ name: str, path: str, type: str, size: num }))

/** One file from the contents API: base64, split over lines. */
export const contentsFileDecoder = obj({
  content: optional(str, ''),
  encoding: optional(str, 'base64'),
  truncated: optional(bool, false),
})

export function decodeContent(file: { content: string; encoding: string }): string {
  if (file.encoding !== 'base64') return file.content
  return Buffer.from(file.content.replace(/\n/g, ''), 'base64').toString('utf8')
}

/**
 * Seconds a run took, or has taken so far, from its start (its creation when
 * it has not started); null only when that timestamp does not parse.
 */
export function runSeconds(run: Run, now: number = Date.now()): number | null {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  if (!Number.isFinite(start)) return null
  const end = run.status === 'completed' ? Date.parse(run.updatedAt) : now
  return Math.max(0, (end - start) / 1000)
}

function jobSeconds(job: Job, now: number = Date.now()): number | null {
  if (job.startedAt === null) return null
  const start = Date.parse(job.startedAt)
  const end = job.completedAt === null ? now : Date.parse(job.completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, (end - start) / 1000)
}

/* ── where a job runs, and what it costs ──────────────────────────────── */

export type RunnerOs = 'linux' | 'windows' | 'macos' | 'unknown'

export type RunsOn = {
  os: RunnerOs
  /** GitHub's machines, as opposed to `self-hosted`. */
  hosted: boolean
  /** For display: the image label the job named, lowercased, else its first label that is not `self-hosted`. */
  label: string
}

/**
 * What a `runs-on` label set means. GitHub-hosted images are named by OS
 * (`ubuntu-24.04`, `windows-latest`, `macos-14`); a self-hosted runner is
 * picked by the `self-hosted` label plus whatever the operator added, which
 * conventionally includes the OS.
 */
export function runsOnOf(labels: readonly string[]): RunsOn {
  const lower = labels.map((l) => l.toLowerCase())
  const hosted = !lower.includes('self-hosted')
  const os: RunnerOs = lower.some((l) => l.startsWith('ubuntu') || l === 'linux')
    ? 'linux'
    : lower.some((l) => l.startsWith('windows'))
      ? 'windows'
      : lower.some((l) => l.startsWith('macos'))
        ? 'macos'
        : 'unknown'
  const label =
    lower.find((l) => /^(ubuntu|windows|macos)/.test(l)) ??
    labels.find((l) => l.toLowerCase() !== 'self-hosted') ??
    labels[0] ??
    ''
  return { os, hosted, label }
}

/**
 * GitHub's minute multipliers for hosted runners: a Windows minute bills as
 * two, a macOS minute as ten. Self-hosted minutes bill as nothing.
 */
export const MINUTE_MULTIPLIER: Record<RunnerOs, number> = {
  linux: 1,
  windows: 2,
  macos: 10,
  unknown: 1,
}

/**
 * Billable minutes for one job, the way GitHub counts them: each job's
 * duration rounded UP to whole minutes, times the OS multiplier, and only on
 * GitHub's own runners.
 */
export function jobMinutes(job: Job, now: number = Date.now()): { raw: number; billed: number } {
  const seconds = jobSeconds(job, now)
  if (seconds === null) return { raw: 0, billed: 0 }
  const raw = Math.ceil(seconds / 60)
  const on = runsOnOf(job.labels)
  return { raw, billed: on.hosted ? raw * MINUTE_MULTIPLIER[on.os] : 0 }
}

/* ── the workflow file ────────────────────────────────────────────────── */

export type WorkflowFile = {
  name: string | null
  /** Top-level `on:` keys — push, pull_request, schedule, workflow_dispatch… */
  triggers: string[]
  crons: string[]
  /** Every `runs-on` value the file names; a list is one entry, an expression expands per `scanWorkflow`. */
  runsOn: string[]
  /** `owner/repo` of every action `uses:` names, distinct. */
  uses: string[]
  jobs: number
}

const listItems = (s: string): string[] =>
  s
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
    .filter((x) => x !== '')

/**
 * What a workflow file says, without a YAML parser: the handful of keys the
 * page reads are line-shaped in every workflow this box has ever seen, and
 * the tolerant reading here is right where a strict parser would refuse a
 * `${{ }}` expression. A `runs-on` that is an expression resolves through
 * every inline `os: [...]` list in the file, else stays as written.
 */
export function scanWorkflow(text: string): WorkflowFile {
  const lines = text.split(/\r?\n/)
  const name =
    lines
      .find((l) => /^name:\s*\S/.test(l))
      ?.replace(/^name:\s*/, '')
      .trim() ?? null
  const unquote = (s: string) => s.replace(/^['"]|['"]$/g, '')

  const triggers: string[] = []
  const onAt = lines.findIndex((l) => /^(on|'on'|"on"):/.test(l))
  if (onAt >= 0) {
    const inline = (lines[onAt] ?? '').replace(/^(on|'on'|"on"):\s*/, '').trim()
    if (inline !== '') triggers.push(...listItems(inline))
    else {
      for (let i = onAt + 1; i < lines.length; i++) {
        const l = lines[i] ?? ''
        if (l.trim() === '' || l.trimStart().startsWith('#')) continue
        if (!/^\s/.test(l)) break
        const m = /^ {2}(?:- )?([a-z_]+):?/.exec(l)
        if (m?.[1] !== undefined && !/^ {3}/.test(l)) triggers.push(m[1])
      }
    }
  }

  const crons = [...text.matchAll(/^\s*-?\s*cron:\s*['"]?([^'"\n#]+)['"]?/gm)].map((m) =>
    (m[1] ?? '').trim(),
  )

  const matrixOs = [...text.matchAll(/^\s*os:\s*(\[[^\]]*\])/gm)].flatMap((m) =>
    listItems(m[1] ?? ''),
  )
  const runsOn = [...text.matchAll(/^\s*runs-on:\s*(.+)$/gm)].flatMap((m) => {
    const v = (m[1] ?? '').trim()
    if (v.startsWith('[')) return [listItems(v).join(', ')]
    if (v.includes('${{')) return matrixOs.length > 0 ? matrixOs : [v]
    return [unquote(v)]
  })

  const uses = [
    ...new Set(
      [...text.matchAll(/^\s*-?\s*uses:\s*['"]?([^@\s'"]+)/gm)]
        .map((m) => m[1] ?? '')
        .filter((u) => u !== '' && !u.startsWith('./') && !u.startsWith('docker://'))
        .map((u) => u.split('/').slice(0, 2).join('/')),
    ),
  ]

  const jobsAt = lines.findIndex((l) => /^jobs:/.test(l))
  let jobs = 0
  if (jobsAt >= 0) {
    for (let i = jobsAt + 1; i < lines.length; i++) {
      const l = lines[i] ?? ''
      if (l.trim() === '' || l.trimStart().startsWith('#')) continue
      if (!/^\s/.test(l)) break
      if (/^ {2}[A-Za-z0-9_-]+:/.test(l)) jobs++
    }
  }

  return { name, triggers, crons, runsOn, uses, jobs }
}

/**
 * A cron as GitHub writes it, in words for the common shapes; the
 * expression itself otherwise.
 */
export function cronWords(cron: string): string {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/)
  if (min === undefined || hour === undefined) return cron
  const hhmm = (h: string, m: string) => `${h.padStart(2, '0')}:${m.padStart(2, '0')} UTC`
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*') {
    if (dow === '*') return `daily at ${hhmm(hour, min)}`
    if (dow !== undefined && /^\d$/.test(dow)) {
      return `${days[Number(dow)] ?? dow} at ${hhmm(hour, min)}`
    }
  }
  if (min === '0' && hour.startsWith('*/') && dom === '*') return `every ${hour.slice(2)} hours`
  if (min.startsWith('*/') && hour === '*') return `every ${min.slice(2)} minutes`
  return cron
}

/* ── buckets and rates ────────────────────────────────────────────────── */

export type DayBucket = { label: string; value: number; flag: boolean }

/** One column per day, oldest first, with a flag on days that had a failure. */
export function dayBuckets(
  runs: readonly Run[],
  days: number,
  now: number = Date.now(),
  weight: (r: Run) => number = () => 1,
): DayBucket[] {
  const dayMs = 86_400_000
  const start = Math.floor(now / dayMs) * dayMs - (days - 1) * dayMs
  const out: DayBucket[] = Array.from({ length: days }, (_, i) => {
    const d = new Date(start + i * dayMs)
    return {
      label: `${String(d.getUTCMonth() + 1)}/${String(d.getUTCDate())}`,
      value: 0,
      flag: false,
    }
  })
  for (const r of runs) {
    const t = Date.parse(r.createdAt)
    const i = Math.floor((t - start) / dayMs)
    const b = out[i]
    if (b === undefined) continue
    b.value += weight(r)
    if (r.conclusion === 'failure' || r.conclusion === 'timed_out') b.flag = true
  }
  return out
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i] ?? null
}

/** GitHub's conclusions, as a tone for a chip. */
export function conclusionTone(
  status: RunStatus | string,
  conclusion: string | null,
): 'ok' | 'bad' | 'warn' | 'muted' | 'accent' {
  if (status !== 'completed') return 'accent'
  switch (conclusion) {
    case 'success':
      return 'ok'
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'bad'
    case 'cancelled':
    case 'action_required':
    case 'stale':
      return 'warn'
    default:
      return 'muted'
  }
}

/** The word the chip shows. */
export function conclusionWord(status: RunStatus | string, conclusion: string | null): string {
  if (status === 'in_progress') return 'running'
  if (
    status === 'queued' ||
    status === 'waiting' ||
    status === 'pending' ||
    status === 'requested'
  ) {
    return status
  }
  return (conclusion ?? 'done').replace(/_/g, ' ')
}

/** One column per day from a `YYYY-MM-DD` → value map, oldest first. */
export function dayMinutes(
  perDay: ReadonlyMap<string, number>,
  days: number,
  now: number = Date.now(),
): DayBucket[] {
  const dayMs = 86_400_000
  const start = Math.floor(now / dayMs) * dayMs - (days - 1) * dayMs
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start + i * dayMs)
    return {
      label: `${String(d.getUTCMonth() + 1)}/${String(d.getUTCDate())}`,
      value: perDay.get(d.toISOString().slice(0, 10)) ?? 0,
      flag: false,
    }
  })
}
