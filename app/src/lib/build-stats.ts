import { buildTimeline } from './build-display'
import { ACTIVE_BUILD_STATES, type BuildPublish, type BuildState } from './builds'

// What the builder's history says in aggregate, for System › Builder: per app,
// how often a build lands and how long it takes; per stage, how long each one
// usually runs; and the latest failures with the line that explains them.
// Pure — the rows come from lib/repo/build-views.ts `buildsSince`.

/** One build as the stats read it: the list columns plus its timings. */
export type BuildStatRow = {
  id: string
  app: string
  sha: string
  state: BuildState
  publish: BuildPublish
  phase: string
  error: string | null
  timings: Record<string, number>
  createdAt: string
  startedAt: string | null
  updatedAt: string
}

export type AppBuildStats = {
  app: string
  total: number
  succeeded: number
  failed: number
  /**
   * Succeeded over succeeded + failed. Cancelled and superseded builds are
   * someone's decision, not the builder's result, so they count toward
   * neither. Null when nothing finished either way.
   */
  successRate: number | null
  /** Median hand-off-to-finish of the succeeded builds. */
  medianMs: number | null
  lastAt: string
}

export type StageStats = { phase: string; medianMs: number | null; count: number }

export type BuildFailure = {
  id: string
  app: string
  sha: string
  at: string
  /** The stage it failed in, as the timeline reads it; the row's phase otherwise. */
  phase: string
  /** The first non-empty line of the error, or null when there was none. */
  error: string | null
}

export type BuildStats = {
  total: number
  succeeded: number
  failed: number
  successRate: number | null
  /** Median hand-off-to-finish of every succeeded build. */
  medianMs: number | null
  apps: AppBuildStats[]
  stages: StageStats[]
  failures: BuildFailure[]
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  const hi = s[mid] ?? 0
  return s.length % 2 === 1 ? hi : ((s[mid - 1] ?? 0) + hi) / 2
}

const rate = (ok: number, bad: number): number | null => (ok + bad === 0 ? null : ok / (ok + bad))

/** From hand-off to the last word, for a build that finished. */
function tookMs(r: BuildStatRow): number | null {
  if (r.startedAt === null) return null
  const ms = Date.parse(r.updatedAt) - Date.parse(r.startedAt)
  return Number.isFinite(ms) && ms >= 0 ? ms : null
}

export function firstLine(text: string | null): string | null {
  const line = (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  return line ?? null
}

function failedPhase(r: BuildStatRow): string {
  const step = buildTimeline(r.state, r.timings).find((s) => s.status === 'failed')
  return step?.phase ?? (r.phase === '' ? 'unknown' : r.phase)
}

/** `rows` in any order; `failureLimit` newest failures are kept. */
export function buildStats(rows: readonly BuildStatRow[], failureLimit = 8): BuildStats {
  const byApp = new Map<string, BuildStatRow[]>()
  for (const r of rows) byApp.set(r.app, [...(byApp.get(r.app) ?? []), r])

  const apps = [...byApp.entries()]
    .map(([app, rs]): AppBuildStats => {
      const succeeded = rs.filter((r) => r.state === 'succeeded')
      const failed = rs.filter((r) => r.state === 'failed').length
      return {
        app,
        total: rs.length,
        succeeded: succeeded.length,
        failed,
        successRate: rate(succeeded.length, failed),
        medianMs: median(succeeded.map(tookMs).filter((m) => m !== null)),
        lastAt:
          rs
            .map((r) => r.createdAt)
            .sort()
            .at(-1) ?? '',
      }
    })
    .sort((a, b) => b.total - a.total || a.app.localeCompare(b.app))

  // Every stage a build finished, whatever became of the build after it: a
  // clone that took four seconds took four seconds even if the checks failed.
  const perStage = new Map<string, number[]>()
  for (const r of rows) {
    for (const s of buildTimeline(r.state, r.timings)) {
      if (s.status === 'done' && s.ms !== null) {
        perStage.set(s.phase, [...(perStage.get(s.phase) ?? []), s.ms])
      }
    }
  }
  const stages = ACTIVE_BUILD_STATES.map((phase) => {
    const ms = perStage.get(phase) ?? []
    return { phase, medianMs: median(ms), count: ms.length }
  })

  const failures = rows
    .filter((r) => r.state === 'failed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, failureLimit)
    .map(
      (r): BuildFailure => ({
        id: r.id,
        app: r.app,
        sha: r.sha,
        at: r.updatedAt,
        phase: failedPhase(r),
        error: firstLine(r.error),
      }),
    )

  const ok = rows.filter((r) => r.state === 'succeeded')
  const succeeded = ok.length
  const failed = rows.filter((r) => r.state === 'failed').length
  return {
    total: rows.length,
    succeeded,
    failed,
    successRate: rate(succeeded, failed),
    medianMs: median(ok.map(tookMs).filter((m) => m !== null)),
    apps,
    stages,
    failures,
  }
}
