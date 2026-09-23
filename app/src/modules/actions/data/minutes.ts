import type { Ctx } from '../../../core/ctx'
import { collect, type RepoActions, WINDOW_DAYS } from './collect'
import type { RepoKind } from './github'
import {
  type DayBucket,
  dayMinutes,
  jobMinutes,
  MINUTE_MULTIPLIER,
  type RunnerOs,
  runsOnOf,
} from './parse'

// The Minutes tab: what the month has cost in GitHub-hosted minutes, counted
// the way GitHub bills them — per job, rounded up, times the image's
// multiplier — and what a runner on one of this network's machines would
// have taken off that.
//
// GitHub's own meter (the billing endpoint) needs a user token with the
// `user` scope, which nothing on this box holds; the count here is from the
// jobs the page can read, which is exact for them and blind to the rest. The
// page says how many runs it did not read.

/** GitHub Free: 2,000 hosted minutes a month for private repositories. Public ones are free. */
export const FREE_PLAN_MINUTES = 2_000

export type OsMinutes = Record<RunnerOs, number>

export type RepoMinutes = {
  repo: string
  kind: RepoKind
  url: string
  /** Wall minutes per image, before the multiplier. */
  raw: OsMinutes
  /** Billed minutes, after it. */
  billed: number
  selfHosted: number
  jobs: number
  /** Runs in the window whose jobs were not read (beyond the page's sample). */
  unread: number
}

export type MinutesData = {
  windowDays: number
  month: { label: string; from: string }
  allowance: number
  totals: {
    billed: number
    /** Month to date, the same count restricted to this calendar month. */
    billedThisMonth: number
    raw: OsMinutes
    billedByOs: OsMinutes
    selfHosted: number
    jobs: number
    unread: number
    readableRepos: number
  }
  byRepo: RepoMinutes[]
  /** Billed minutes per workflow, the job that dominates each. */
  byWorkflow: { label: string; billed: number; topJob: string | null; topJobBilled: number }[]
  days: DayBucket[]
  /** What a runner here would have absorbed, by the machine that could host it. */
  saving: { os: RunnerOs; billed: number; raw: number; jobs: number }[]
  multipliers: OsMinutes
}

const zero = (): OsMinutes => ({ linux: 0, windows: 0, macos: 0, unknown: 0 })

export function assembleMinutes(repos: RepoActions[], now: number): MinutesData {
  const monthStart = new Date(now)
  monthStart.setUTCDate(1)
  monthStart.setUTCHours(0, 0, 0, 0)
  const from = monthStart.toISOString().slice(0, 10)
  const label = monthStart.toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  })

  const raw = zero()
  const billedByOs = zero()
  let billed = 0
  let billedThisMonth = 0
  let selfHosted = 0
  let jobs = 0
  let unread = 0
  const saving = new Map<RunnerOs, { billed: number; raw: number; jobs: number }>()
  const perDay = new Map<string, number>()
  const perWorkflow = new Map<string, { billed: number; jobs: Map<string, number> }>()

  const byRepo: RepoMinutes[] = repos.map((r) => {
    const rr = zero()
    let rb = 0
    let rs = 0
    let rj = 0
    for (const run of r.runs) {
      const js = r.jobs.get(run.id)
      if (js === undefined) {
        unread++
        continue
      }
      for (const j of js) {
        const m = jobMinutes(j, now)
        if (m.raw === 0) continue
        const on = runsOnOf(j.labels)
        rj++
        if (!on.hosted) {
          rs += m.raw
          continue
        }
        rr[on.os] += m.raw
        rb += m.billed
        const day = (j.startedAt ?? run.createdAt).slice(0, 10)
        perDay.set(day, (perDay.get(day) ?? 0) + m.billed)
        if ((j.startedAt ?? run.createdAt) >= from) billedThisMonth += m.billed
        const wkey = `${r.repo.short} · ${run.workflow}`
        const w = perWorkflow.get(wkey) ?? { billed: 0, jobs: new Map<string, number>() }
        w.billed += m.billed
        w.jobs.set(j.name, (w.jobs.get(j.name) ?? 0) + m.billed)
        perWorkflow.set(wkey, w)
        const s = saving.get(on.os) ?? { billed: 0, raw: 0, jobs: 0 }
        saving.set(on.os, { billed: s.billed + m.billed, raw: s.raw + m.raw, jobs: s.jobs + 1 })
      }
    }
    for (const os of Object.keys(rr) as RunnerOs[]) {
      raw[os] += rr[os]
      billedByOs[os] += rr[os] * MINUTE_MULTIPLIER[os]
    }
    billed += rb
    selfHosted += rs
    jobs += rj
    return {
      repo: r.repo.short,
      kind: r.repo.kind,
      url: r.repo.url,
      raw: rr,
      billed: rb,
      selfHosted: rs,
      jobs: rj,
      unread: r.runs.filter((run) => !r.jobs.has(run.id)).length,
    }
  })

  return {
    windowDays: WINDOW_DAYS,
    month: { label, from },
    allowance: FREE_PLAN_MINUTES,
    totals: {
      billed,
      billedThisMonth,
      raw,
      billedByOs,
      selfHosted,
      jobs,
      unread,
      readableRepos: repos.filter((r) => r.access.runs === 'app' || r.access.runs === 'public')
        .length,
    },
    byRepo: byRepo.filter((r) => r.jobs > 0 || r.unread > 0).sort((a, b) => b.billed - a.billed),
    byWorkflow: [...perWorkflow.entries()]
      .map(([label, w]) => {
        const top = [...w.jobs.entries()].sort((a, b) => b[1] - a[1])[0]
        return { label, billed: w.billed, topJob: top?.[0] ?? null, topJobBilled: top?.[1] ?? 0 }
      })
      .sort((a, b) => b.billed - a.billed)
      .slice(0, 12),
    days: dayMinutes(perDay, WINDOW_DAYS, now),
    saving: (['linux', 'windows', 'macos'] as const)
      .map((os) => ({ os, ...(saving.get(os) ?? { billed: 0, raw: 0, jobs: 0 }) }))
      .filter((s) => s.jobs > 0),
    multipliers: MINUTE_MULTIPLIER,
  }
}

export async function loadMinutes(ctx: Ctx): Promise<MinutesData> {
  const now = Date.now()
  return assembleMinutes(await collect(ctx, now), now)
}
