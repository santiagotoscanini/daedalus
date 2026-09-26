import type { Ctx } from '../../../core/ctx'
import { collect, type RepoActions, WINDOW_DAYS } from './collect'
import { type Access, type AnonBudget, anonBudget, type RepoKind } from './github'
import {
  type DayBucket,
  dayBuckets,
  type Job,
  percentile,
  type Run,
  runSeconds,
  runsOnOf,
} from './parse'

// The Runs tab: every workflow run across the box's repositories in the
// last thirty days, as one feed and its numbers.

export type RunRow = {
  id: number
  repo: string
  repoKind: RepoKind
  workflow: string
  branch: string | null
  event: string
  status: string
  conclusion: string | null
  actor: string | null
  sha7: string
  /** Seconds, so far or in total. */
  seconds: number | null
  createdAt: string
  url: string
  /** Where the jobs ran: hosted images by OS, or self-hosted. Empty when unread. */
  ranOn: string[]
  /** The job and step that failed, for a failed run. */
  failed: { job: string; step: string | null; url: string } | null
}

type RepoRunsSummary = {
  repo: string
  kind: RepoKind
  url: string
  access: Access
  runs: number
  failed: number
  /** GitHub's own count for the window; above `runs` when the page did not hold it all. */
  total: number
  p50: number | null
}

export type RunsData = {
  windowDays: number
  totals: {
    runs: number
    ok: number
    failed: number
    cancelled: number
    running: number
    queued: number
    p50: number | null
    p95: number | null
    /** Repositories the box could read runs for, over those it watches. */
    readable: number
    watched: number
  }
  running: RunRow[]
  recent: RunRow[]
  failures: RunRow[]
  days: DayBucket[]
  byRepo: RepoRunsSummary[]
  byWorkflow: { label: string; runs: number; failed: number; p50: number | null }[]
  byEvent: { label: string; value: number }[]
  /** The repositories the App could not read, with why. */
  unreadable: { repo: string; url: string; access: Access }[]
  /** Repositories read as anyone, out of the address's sixty-an-hour budget. */
  publicRepos: number
  budget: AnonBudget
}

function ranOn(jobs: Job[] | undefined): string[] {
  if (jobs === undefined) return []
  const seen = new Set<string>()
  for (const j of jobs) {
    const on = runsOnOf(j.labels)
    seen.add(on.hosted ? on.label : `self-hosted${on.os === 'unknown' ? '' : ` ${on.os}`}`)
  }
  return [...seen]
}

function failedOf(jobs: Job[] | undefined): RunRow['failed'] {
  const j = jobs?.find((x) => x.conclusion === 'failure' || x.conclusion === 'timed_out')
  return j === undefined ? null : { job: j.name, step: j.failedStep, url: j.url }
}

function rowOf(r: Run, repo: RepoActions, now: number): RunRow {
  const jobs = repo.jobs.get(r.id)
  return {
    id: r.id,
    repo: repo.repo.short,
    repoKind: repo.repo.kind,
    workflow: r.workflow,
    branch: r.branch,
    event: r.event,
    status: r.status,
    conclusion: r.conclusion,
    actor: r.actor,
    sha7: r.sha.slice(0, 7),
    seconds: runSeconds(r, now),
    createdAt: r.createdAt,
    url: r.url,
    ranOn: ranOn(jobs),
    failed: failedOf(jobs),
  }
}

const byNewest = (a: Run, b: Run) => Date.parse(b.createdAt) - Date.parse(a.createdAt)

function assembleRuns(repos: RepoActions[], now: number): RunsData {
  const all: { run: Run; repo: RepoActions }[] = repos
    .flatMap((repo) => repo.runs.map((run) => ({ run, repo })))
    .sort((a, b) => byNewest(a.run, b.run))
  const runs = all.map((x) => x.run)
  const done = runs.filter((r) => r.status === 'completed')
  const secondsOf = (rs: Run[]) =>
    rs.map((r) => runSeconds(r, now)).filter((s): s is number => s !== null)

  const count = (f: (r: Run) => boolean) => runs.filter(f).length
  const rows = (xs: typeof all) => xs.map((x) => rowOf(x.run, x.repo, now))

  const workflows = new Map<string, Run[]>()
  for (const r of runs) {
    const key = `${r.repo.split('/')[1] ?? r.repo} · ${r.workflow}`
    workflows.set(key, [...(workflows.get(key) ?? []), r])
  }
  const events = new Map<string, number>()
  for (const r of runs) events.set(r.event, (events.get(r.event) ?? 0) + 1)

  return {
    windowDays: WINDOW_DAYS,
    totals: {
      runs: runs.length,
      ok: count((r) => r.conclusion === 'success'),
      failed: count((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out'),
      cancelled: count((r) => r.conclusion === 'cancelled'),
      running: count((r) => r.status === 'in_progress'),
      queued: count(
        (r) => r.status === 'queued' || r.status === 'waiting' || r.status === 'pending',
      ),
      p50: percentile(secondsOf(done), 50),
      p95: percentile(secondsOf(done), 95),
      readable: repos.filter((r) => r.access.runs === 'app' || r.access.runs === 'public').length,
      watched: repos.length,
    },
    running: rows(all.filter((x) => x.run.status !== 'completed')),
    recent: rows(all.slice(0, 40)),
    failures: rows(
      all
        .filter((x) => x.run.conclusion === 'failure' || x.run.conclusion === 'timed_out')
        .slice(0, 12),
    ),
    days: dayBuckets(runs, WINDOW_DAYS, now),
    byRepo: repos
      .map((repo) => ({
        repo: repo.repo.short,
        kind: repo.repo.kind,
        url: repo.repo.url,
        access: repo.access.runs,
        runs: repo.runs.length,
        failed: repo.runs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out')
          .length,
        total: repo.runsTotal,
        p50: percentile(secondsOf(repo.runs.filter((r) => r.status === 'completed')), 50),
      }))
      .sort((a, b) => b.runs - a.runs),
    byWorkflow: [...workflows.entries()]
      .map(([label, rs]) => ({
        label,
        runs: rs.length,
        failed: rs.filter((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out').length,
        p50: percentile(secondsOf(rs.filter((r) => r.status === 'completed')), 50),
      }))
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 12),
    byEvent: [...events.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    unreadable: repos
      .filter((r) => r.access.runs !== 'app' && r.access.runs !== 'public')
      .map((r) => ({ repo: r.repo.short, url: r.repo.url, access: r.access.runs })),
    publicRepos: repos.filter((r) => r.access.runs === 'public').length,
    budget: anonBudget(now),
  }
}

export async function loadRuns(ctx: Ctx): Promise<RunsData> {
  const now = Date.now()
  return assembleRuns(await collect(ctx, now), now)
}
