import { CHECK_RUN_NAME } from '../lib/github-app'
import type { Ctx } from './ctx'
import { type GhResult, ghApp } from './github-app'

// What the daedalus App writes to GitHub about a build: the check run, a
// Deployment, and the Deployment's statuses. Thin typed wrappers over ghApp;
// like it, nothing here throws, and the body is never logged or returned.
//
// Field names follow the REST API at 2022-11-28 (checks/runs,
// deployments/deployments, deployments/statuses). Not used on purpose:
// `task` (default "deploy"), `auto_inactive` (default true, which is what
// retires the previous production Deployment's status), check-run
// `annotations`/`actions`.

export type RepoRef = { owner: string; repo: string }

export type GhFailure =
  | 'no-token'
  | 'timeout'
  | 'unreachable'
  | 'invalid-path'
  | 'rate-limited'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'not-created'
  | 'invalid'
  | 'server'
  | 'unexpected'

export type GhCall<T> =
  | { ok: true; value: T }
  | { ok: false; failure: GhFailure; status: number | null; retryAfterMs: number | null }

/** Why a ghApp result is not the answer that was asked for. */
export function failureOf(r: GhResult): GhFailure {
  if (r.error !== null) return r.error
  if (r.retryAfterMs !== null) return 'rate-limited'
  switch (r.status) {
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not-found'
    case 409:
      return 'conflict'
    case 422:
      return 'invalid'
  }
  return r.status !== null && r.status >= 500 ? 'server' : 'unexpected'
}

const fail = <T>(r: GhResult, failure: GhFailure = failureOf(r)): GhCall<T> => ({
  ok: false,
  failure,
  status: r.status,
  retryAfterMs: r.retryAfterMs,
})

const refused = <T>(): GhCall<T> => ({
  ok: false,
  failure: 'invalid-path',
  status: null,
  retryAfterMs: null,
})

// GitHub's own rules for an owner and a repository name: nothing here may
// turn a name into another path.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

function repoPath(repo: RepoRef): string | null {
  if (!OWNER_RE.test(repo.owner) || !REPO_RE.test(repo.repo) || /^\.+$/.test(repo.repo)) {
    return null
  }
  return `/repos/${repo.owner}/${repo.repo}`
}

const isId = (n: number): boolean => Number.isSafeInteger(n) && n > 0

function idOf(body: unknown): number | null {
  if (body === null || typeof body !== 'object') return null
  const id = (body as { id?: unknown }).id
  return typeof id === 'number' && isId(id) ? id : null
}

function htmlUrlOf(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  const url = (body as { html_url?: unknown }).html_url
  return typeof url === 'string' ? url : null
}

/** GitHub's documented timestamp shape, YYYY-MM-DDTHH:MM:SSZ. */
export function githubTime(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * At most `max` UTF-16 units, never splitting a surrogate pair, with an
 * ellipsis when cut.
 */
export function clampChars(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max - 1) break
    out += ch
  }
  return `${out}…`
}

/** A deployment status description's documented ceiling. */
export const DESCRIPTION_MAX_CHARS = 140

async function send(ctx: Ctx, method: 'POST' | 'PATCH', path: string, body: unknown) {
  return ghApp(ctx, path, { method, body: JSON.stringify(body) })
}

// ── check runs ─────────────────────────────────────────────────────────────

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed'
export type CheckRunConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'

export type CheckRunOutputBody = { title: string; summary: string; text?: string }
export type CheckRun = { id: number; htmlUrl: string | null }

/**
 * POST /repos/{owner}/{repo}/check-runs. With a conclusion the run is created
 * already completed (GitHub requires one whenever status is `completed`).
 */
export async function createCheckRun(
  ctx: Ctx,
  repo: RepoRef,
  input: {
    headSha: string
    buildId: string
    detailsUrl: string | null
    startedAt: Date
    output: CheckRunOutputBody
    conclusion?: CheckRunConclusion
    completedAt?: Date
  },
): Promise<GhCall<CheckRun>> {
  const base = repoPath(repo)
  if (base === null || !/^[0-9a-f]{40}$/.test(input.headSha)) return refused()
  const body: Record<string, unknown> = {
    name: CHECK_RUN_NAME,
    head_sha: input.headSha,
    external_id: input.buildId,
    status: 'in_progress',
    started_at: githubTime(input.startedAt),
    output: input.output,
  }
  if (input.detailsUrl !== null) body.details_url = input.detailsUrl
  if (input.conclusion !== undefined) {
    body.status = 'completed'
    body.conclusion = input.conclusion
    body.completed_at = githubTime(input.completedAt ?? new Date())
  }
  const r = await send(ctx, 'POST', `${base}/check-runs`, body)
  const id = r.status === 201 ? idOf(r.body) : null
  return id === null ? fail(r) : { ok: true, value: { id, htmlUrl: htmlUrlOf(r.body) } }
}

/** PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}. */
export async function updateCheckRun(
  ctx: Ctx,
  repo: RepoRef,
  checkRunId: number,
  input: {
    status?: CheckRunStatus
    conclusion?: CheckRunConclusion
    completedAt?: Date
    output?: CheckRunOutputBody
  },
): Promise<GhCall<CheckRun>> {
  const base = repoPath(repo)
  if (base === null || !isId(checkRunId)) return refused()
  const body: Record<string, unknown> = {}
  if (input.status !== undefined) body.status = input.status
  if (input.output !== undefined) body.output = input.output
  if (input.conclusion !== undefined) {
    body.status = 'completed'
    body.conclusion = input.conclusion
    body.completed_at = githubTime(input.completedAt ?? new Date())
  }
  const r = await send(ctx, 'PATCH', `${base}/check-runs/${String(checkRunId)}`, body)
  const id = r.status === 200 ? (idOf(r.body) ?? checkRunId) : null
  return id === null ? fail(r) : { ok: true, value: { id, htmlUrl: htmlUrlOf(r.body) } }
}

// ── deployments ────────────────────────────────────────────────────────────

export type DeploymentState =
  | 'error'
  | 'failure'
  | 'inactive'
  | 'in_progress'
  | 'queued'
  | 'pending'
  | 'success'

/**
 * POST /repos/{owner}/{repo}/deployments for the commit itself. With
 * `auto_merge: false` and no required contexts GitHub has nothing to merge or
 * wait for, so its two non-201 answers should not happen: a 202 (it merged
 * the default branch into the ref, and created nothing) is `not-created`, a
 * 409 (merge conflict or failed status checks) is `conflict`.
 */
export async function createDeployment(
  ctx: Ctx,
  repo: RepoRef,
  input: { sha: string; buildId: string; description: string },
): Promise<GhCall<{ id: number }>> {
  const base = repoPath(repo)
  if (base === null || !/^[0-9a-f]{40}$/.test(input.sha)) return refused()
  const r = await send(ctx, 'POST', `${base}/deployments`, {
    ref: input.sha,
    environment: 'production',
    required_contexts: [],
    auto_merge: false,
    transient_environment: false,
    production_environment: true,
    description: clampChars(input.description, DESCRIPTION_MAX_CHARS),
    payload: { buildId: input.buildId },
  })
  if (r.status === 202) return fail(r, 'not-created')
  const id = r.status === 201 ? idOf(r.body) : null
  return id === null ? fail(r) : { ok: true, value: { id } }
}

/** POST /repos/{owner}/{repo}/deployments/{deployment_id}/statuses. */
export async function createDeploymentStatus(
  ctx: Ctx,
  repo: RepoRef,
  deploymentId: number,
  input: {
    state: DeploymentState
    description: string
    environmentUrl?: string | null
    logUrl?: string | null
  },
): Promise<GhCall<{ id: number }>> {
  const base = repoPath(repo)
  if (base === null || !isId(deploymentId)) return refused()
  const body: Record<string, unknown> = {
    state: input.state,
    description: clampChars(input.description, DESCRIPTION_MAX_CHARS),
  }
  if (input.environmentUrl) body.environment_url = input.environmentUrl
  if (input.logUrl) body.log_url = input.logUrl
  const r = await send(ctx, 'POST', `${base}/deployments/${String(deploymentId)}/statuses`, body)
  const id = r.status === 201 ? idOf(r.body) : null
  return id === null ? fail(r) : { ok: true, value: { id } }
}
