import type { Ctx } from '../../../core/ctx'
import {
  type Access,
  anonBudget,
  DONE_TTL,
  ghRead,
  knownRepos,
  type RepoRef,
  remembered,
} from './github'
import {
  contentsFileDecoder,
  contentsListDecoder,
  decodeContent,
  type Job,
  jobsPageDecoder,
  type Run,
  runsPageDecoder,
  scanWorkflow,
  type Workflow,
  type WorkflowFile,
  workflowsPageDecoder,
} from './parse'

// One collection serves every tab: the runs of the last thirty days, the
// jobs behind the recent ones, and every workflow file, per repository.
// The tabs are four readings of it.

/** How far back the page looks. GitHub keeps runs for 90 days; a month is the page. */
export const WINDOW_DAYS = 30
/**
 * Jobs are one call per run. Every run whose jobs are already remembered is
 * read for free; beyond those, this many fresh reads per collection, across
 * every repository, the live and the failed ones first. A completed run's
 * jobs never change, so each visit adds to what the next one knows.
 */
const FRESH_JOB_READS = 16

type WorkflowInfo = {
  /** GitHub's id when the workflows endpoint answered; the file's path otherwise. */
  id: string
  name: string
  path: string
  /** `active`, `disabled_manually`, … — `unknown` when read from the file alone. */
  state: string
  url: string
  file: WorkflowFile | null
}

export type RepoActions = {
  repo: RepoRef
  access: { runs: Access; workflows: Access; files: Access }
  /** Newest first, the window only. */
  runs: Run[]
  /** GitHub's count for the window, which can exceed the page. */
  runsTotal: number
  /** By run id, for the runs jobs were read for. */
  jobs: Map<number, Job[]>
  workflows: WorkflowInfo[]
}

const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10)

async function readRuns(
  ctx: Ctx,
  repo: RepoRef,
  now: number,
): Promise<{ access: Access; runs: Run[]; total: number }> {
  const since = isoDay(now - WINDOW_DAYS * 86_400_000)
  const a = await ghRead(
    ctx,
    `/repos/${repo.fullName}/actions/runs?per_page=100&created=%3E%3D${since}`,
    runsPageDecoder,
  )
  return {
    access: a.access,
    runs: a.value?.workflow_runs ?? [],
    total: a.value?.total_count ?? 0,
  }
}

const jobsPath = (repo: RepoRef, r: Run) =>
  `/repos/${repo.fullName}/actions/runs/${String(r.id)}/attempts/${String(r.attempt)}/jobs?per_page=100`

/** Live first, then failed, then newest: the order the fresh reads go to. */
function jobPriority(r: Run): number {
  if (r.status !== 'completed') return 0
  if (r.conclusion === 'failure' || r.conclusion === 'timed_out') return 1
  return 2
}

async function readJobs(
  ctx: Ctx,
  wanted: { repo: RepoRef; run: Run; access: Access }[],
  now: number,
): Promise<Map<number, Job[]>> {
  const out = new Map<number, Job[]>()
  const free = wanted.filter((w) => remembered(jobsPath(w.repo, w.run), now))
  // A fresh read is only worth issuing where it can answer: as the App where
  // the App read the runs, as anyone where the runs were public and the
  // hour's budget is not spent. Anything else would be sixteen refusals.
  const spent = anonBudget(now).spent
  const fresh = wanted
    .filter((w) => !remembered(jobsPath(w.repo, w.run), now))
    .filter((w) => w.access === 'app' || (w.access === 'public' && !spent))
    .sort(
      (a, b) =>
        jobPriority(a.run) - jobPriority(b.run) ||
        Date.parse(b.run.createdAt) - Date.parse(a.run.createdAt),
    )
    .slice(0, FRESH_JOB_READS)
  await Promise.all(
    [...free, ...fresh].map(async ({ repo, run }) => {
      const a = await ghRead(
        ctx,
        jobsPath(repo, run),
        jobsPageDecoder,
        run.status === 'completed' ? DONE_TTL : 60_000,
        now,
      )
      if (a.value !== null) out.set(run.id, a.value.jobs)
    }),
  )
  return out
}

async function readWorkflows(
  ctx: Ctx,
  repo: RepoRef,
): Promise<{ access: Access; files: Access; workflows: WorkflowInfo[] }> {
  const listed = await ghRead(
    ctx,
    `/repos/${repo.fullName}/actions/workflows?per_page=100`,
    workflowsPageDecoder,
  )
  // The files, through `contents` — a permission the App has always had. A
  // directory that is not there is a repository with no workflows, not a
  // refusal.
  const dir = await ghRead(
    ctx,
    `/repos/${repo.fullName}/contents/.github/workflows`,
    contentsListDecoder,
    10 * 60_000,
  )
  const files = new Map<string, WorkflowFile>()
  if (dir.value !== null) {
    await Promise.all(
      dir.value
        .filter((f) => f.type === 'file' && /\.ya?ml$/.test(f.name))
        .map(async (f) => {
          const file = await ghRead(
            ctx,
            `/repos/${repo.fullName}/contents/${f.path}`,
            contentsFileDecoder,
            10 * 60_000,
          )
          if (file.value !== null && !file.value.truncated) {
            files.set(f.path, scanWorkflow(decodeContent(file.value)))
          }
        }),
    )
  }

  const fromApi: Workflow[] = listed.value?.workflows ?? []
  const workflows: WorkflowInfo[] =
    fromApi.length > 0
      ? fromApi.map((w) => ({
          id: String(w.id),
          name: w.name,
          path: w.path,
          state: w.state,
          url: w.url,
          file: files.get(w.path) ?? null,
        }))
      : [...files.entries()].map(([path, file]) => ({
          id: path,
          name: file.name ?? path.replace(/^\.github\/workflows\//, ''),
          path,
          state: 'unknown',
          url: `${repo.url}/blob/HEAD/${path}`,
          file,
        }))
  return { access: listed.access, files: dir.access, workflows }
}

export async function collect(ctx: Ctx, now: number = Date.now()): Promise<RepoActions[]> {
  const repos = await knownRepos(ctx)
  const read = await Promise.all(
    repos.map(async (repo) => {
      const [runs, wf] = await Promise.all([readRuns(ctx, repo, now), readWorkflows(ctx, repo)])
      return { repo, runs, wf }
    }),
  )
  const jobs = await readJobs(
    ctx,
    read.flatMap(({ repo, runs }) => runs.runs.map((run) => ({ repo, run, access: runs.access }))),
    now,
  )
  return read.map(({ repo, runs, wf }) => ({
    repo,
    access: { runs: runs.access, workflows: wf.access, files: wf.files },
    runs: runs.runs,
    runsTotal: runs.total,
    jobs: new Map(runs.runs.filter((r) => jobs.has(r.id)).map((r) => [r.id, jobs.get(r.id) ?? []])),
    workflows: wf.workflows,
  }))
}
