import type { Ctx } from '../../../core/ctx'
import { collect, type RepoActions } from './collect'
import type { Access, RepoKind } from './github'
import { cronWords, percentile, type RunnerOs, runSeconds, runsOnOf } from './parse'

// The Workflows tab: every workflow file the box's repositories carry, what
// triggers it, where it asks to run, and how it has been doing.
//
// The files come through `contents`, which the App has always been able to
// read — so this tab is whole before the App can read a single run. Its
// count of what the files ask of GitHub's Linux, Windows and macOS images is
// the demand the Runners tab holds this network's machines against.

type WorkflowRow = {
  id: string
  name: string
  path: string
  url: string
  state: string
  triggers: string[]
  /** In words where the shape is common, else the expression. */
  schedules: string[]
  /** The runs-on values the file names (see `WorkflowFile.runsOn`). */
  runsOn: string[]
  /** Distinct actions the file uses, `owner/repo`. */
  uses: string[]
  jobs: number
  /** From the window's runs, when readable. */
  runs: number
  failed: number
  p50: number | null
  lastRun: { at: string; conclusion: string | null; status: string; url: string } | null
}

type RepoWorkflows = {
  repo: string
  kind: RepoKind
  url: string
  access: { workflows: Access; files: Access; runs: Access }
  workflows: WorkflowRow[]
}

export type WorkflowsData = {
  repos: RepoWorkflows[]
  totals: {
    workflows: number
    scheduled: number
    dispatchable: number
    onPush: number
    onPullRequest: number
    /** `runs-on` values by the image they name, across every file; a matrix counts once per image. */
    images: Record<RunnerOs, number>
    selfHosted: number
    /** Every action used, most used first. */
    actions: { label: string; value: number }[]
  }
}

export function assembleWorkflows(repos: RepoActions[]): WorkflowsData {
  const images: Record<RunnerOs, number> = { linux: 0, windows: 0, macos: 0, unknown: 0 }
  let selfHosted = 0
  const actions = new Map<string, number>()
  let scheduled = 0
  let dispatchable = 0
  let onPush = 0
  let onPullRequest = 0
  let workflows = 0

  const out: RepoWorkflows[] = repos.map((r) => ({
    repo: r.repo.short,
    kind: r.repo.kind,
    url: r.repo.url,
    access: r.access,
    workflows: r.workflows.map((w) => {
      workflows++
      const f = w.file
      const runs = r.runs.filter((x) => String(x.workflowId) === w.id || x.workflow === w.name)
      const last = runs[0]
      if (f !== null) {
        if (f.triggers.includes('schedule')) scheduled++
        if (f.triggers.includes('workflow_dispatch')) dispatchable++
        if (f.triggers.includes('push')) onPush++
        if (f.triggers.includes('pull_request')) onPullRequest++
        for (const label of f.runsOn) {
          const on = runsOnOf(label.split(',').map((s) => s.trim()))
          if (on.hosted) images[on.os]++
          else selfHosted++
        }
        for (const u of f.uses) actions.set(u, (actions.get(u) ?? 0) + 1)
      }
      return {
        id: w.id,
        name: w.name,
        path: w.path,
        url: w.url,
        state: w.state,
        triggers: f?.triggers ?? [],
        schedules: (f?.crons ?? []).map(cronWords),
        runsOn: f?.runsOn ?? [],
        uses: f?.uses ?? [],
        jobs: f?.jobs ?? 0,
        runs: runs.length,
        failed: runs.filter((x) => x.conclusion === 'failure' || x.conclusion === 'timed_out')
          .length,
        p50: percentile(
          runs
            .filter((x) => x.status === 'completed')
            .map((x) => runSeconds(x))
            .filter((s): s is number => s !== null),
          50,
        ),
        lastRun:
          last === undefined
            ? null
            : {
                at: last.createdAt,
                conclusion: last.conclusion,
                status: last.status,
                url: last.url,
              },
      }
    }),
  }))

  return {
    repos: out,
    totals: {
      workflows,
      scheduled,
      dispatchable,
      onPush,
      onPullRequest,
      images,
      selfHosted,
      actions: [...actions.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value),
    },
  }
}

export async function loadWorkflows(ctx: Ctx): Promise<WorkflowsData> {
  return assembleWorkflows(await collect(ctx))
}
