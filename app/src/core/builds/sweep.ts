// The scheduler's hourly sweep, run out of band from the tick: prune old
// webhook deliveries, pin each registry app to its GitHub repository by name,
// and enqueue a default-branch HEAD that no push delivered (tunnel down, a
// lost delivery, a container restart). scheduler.ts decides when it runs; the
// record it leaves is stored as `builds.lastSweep` (no page reads it yet).

import {
  BUILD_PUBLISH_MODES,
  BUILD_SHA_RE,
  BUILD_STRATEGIES,
  type BuildPublish,
  type BuildStrategy,
} from '../../lib/builds'
import type { AppRecord } from '../../lib/repo/apps'
import type { Ctx } from '../ctx'
import { enqueueChecked } from './dispatch'
import type { SchedulerState } from './scheduler'
import { logOnce, quietly } from './scheduler-log'

const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000

export type SweepRecord = {
  at: string
  pinned: string[]
  enqueued: string[]
  /** Why the GitHub half did not run; null when it did. */
  skipped: string | null
}

type GithubModule = typeof import('../github-app')
type InstallationRepo = Extract<
  Awaited<ReturnType<GithubModule['listInstallationRepos']>>,
  { ok: true }
>['repos'][number]

const strategyOf = (v: string): BuildStrategy =>
  (BUILD_STRATEGIES as readonly string[]).includes(v) ? (v as BuildStrategy) : 'auto'
const publishOf = (v: string): BuildPublish =>
  (BUILD_PUBLISH_MODES as readonly string[]).includes(v) ? (v as BuildPublish) : 'live'

const segments = (s: string): string => s.split('/').map(encodeURIComponent).join('/')

/** Pin repos, enqueue unbuilt HEADs, prune deliveries. Never throws for GitHub. */
export async function runSweep(ctx: Ctx, now: Date, state: SchedulerState): Promise<SweepRecord> {
  const at = now.getTime()
  const record: SweepRecord = { at: now.toISOString(), pinned: [], enqueued: [], skipped: null }

  await quietly(state, 'prune-deliveries', async () => {
    const { pruneDeliveries } = await import('../../lib/repo/github-deliveries')
    const n = await pruneDeliveries(new Date(at - DELIVERY_RETENTION_MS))
    if (n > 0) console.info(`[builds] pruned ${String(n)} webhook deliveries older than 7 days`)
  })

  record.skipped = await sweepGithub(ctx, now, state, record)

  await quietly(state, 'record-sweep', async () => {
    const { SETTING_KEYS } = await import('../../lib/repo/settings')
    await ctx.store.write(SETTING_KEYS.buildsLastSweep, record)
  })
  return record
}

async function sweepGithub(
  ctx: Ctx,
  now: Date,
  state: SchedulerState,
  record: SweepRecord,
): Promise<string | null> {
  const at = now.getTime()
  if (at < state.githubBackoffUntil) return 'rate limited'

  const github = await import('../github-app')
  const { tokenUsable } = await import('../../host/github-token')
  if (!tokenUsable(await github.installationState(ctx), at)) {
    logOnce(state, 'github:no-token', 'sweep: no usable installation token; GitHub skipped', at)
    return 'no usable installation token'
  }

  const listed = await github.listInstallationRepos(ctx)
  if (!listed.ok) {
    logOnce(state, 'github:list-repos', `sweep: listing repositories failed: ${listed.reason}`, at)
    backoff(state, at, listed.retryAfterMs)
    return listed.reason
  }

  const { listApps } = await import('../../lib/repo/apps')
  const byName = new Map(listed.repos.map((r) => [r.name.toLowerCase(), r]))
  const byId = new Map(listed.repos.map((r) => [r.id, r]))
  const apps = (await listApps()).filter((a) => !a.managedInNix && a.sourceMode === 'registry')

  for (const app of apps) {
    const repoId = await pinApp(app, byName.get(app.name.toLowerCase()), state, record, at)
    // Pinned by someone else between the read and the write: next sweep.
    if (repoId === 'raced') continue

    if (!app.buildOnBox || repoId === null) continue
    const target = byId.get(repoId)
    if (target === undefined) {
      logOnce(
        state,
        `repo-missing:${app.name}`,
        `sweep: ${app.name}'s repository ${String(repoId)} is not in the installation`,
        at,
      )
      continue
    }
    const stop = await enqueueUnbuiltHead(ctx, github, app, target, now, state, record)
    if (stop !== null) return stop
  }
  return null
}

function backoff(state: SchedulerState, at: number, retryAfterMs: number | null): void {
  if (retryAfterMs !== null) state.githubBackoffUntil = at + retryAfterMs
}

/**
 * The app's repository id: its pin, or the id of the repository named like it,
 * pinned now. `raced` when another writer pinned it between the read and the
 * write. A pin that disagrees with the name is kept, and said once an hour.
 */
async function pinApp(
  app: AppRecord,
  named: InstallationRepo | undefined,
  state: SchedulerState,
  record: SweepRecord,
  at: number,
): Promise<number | null | 'raced'> {
  const repoId = app.githubRepoId
  if (repoId === null && named !== undefined) {
    const repo = await import('../../lib/repo/builds')
    if (!(await repo.pinGithubRepoId(app.id, named.id))) return 'raced'
    console.info(
      `[builds] pinned ${app.name} to ${named.fullName} (repository id ${String(named.id)})`,
    )
    record.pinned.push(app.name)
    return named.id
  }
  if (repoId !== null && named !== undefined && named.id !== repoId) {
    logOnce(
      state,
      `pin-mismatch:${app.name}`,
      `${app.name} is pinned to repository id ${String(repoId)}, but ${named.fullName} is ${String(named.id)}; the pin is kept`,
      at,
    )
  }
  return repoId
}

/**
 * Enqueue the default branch's HEAD when its newest success is another sha.
 * 'rate limited' when GitHub said to wait, which ends the whole sweep.
 */
async function enqueueUnbuiltHead(
  ctx: Ctx,
  github: GithubModule,
  app: AppRecord,
  target: InstallationRepo,
  now: Date,
  state: SchedulerState,
  record: SweepRecord,
): Promise<'rate limited' | null> {
  const at = now.getTime()
  const [owner = '', name = ''] = target.fullName.split('/')
  const head = await github.ghApp<{ sha?: unknown }>(
    ctx,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${segments(target.defaultBranch)}`,
  )
  const sha = head.status === 200 ? head.body?.sha : undefined
  if (typeof sha !== 'string' || !BUILD_SHA_RE.test(sha)) {
    logOnce(
      state,
      `github:head:${String(head.error ?? head.status)}`,
      `sweep: reading ${target.fullName}'s ${target.defaultBranch} failed: ${github.describeGhFailure(head)}`,
      at,
    )
    if (head.retryAfterMs !== null) {
      backoff(state, at, head.retryAfterMs)
      return 'rate limited'
    }
    return null
  }

  const repo = await import('../../lib/repo/builds')
  const publish = publishOf(app.buildPublish)
  const built = await repo.latestSucceeded(app.id, 'main', publish)
  if (built?.sha === sha) return null
  // A HEAD whose last build failed is skipped inside (build-queue.ts failedTip):
  // a push or Build now builds it again, the sweep does not.
  const outcome = await enqueueChecked(
    {
      appId: app.id,
      app: app.name,
      lane: 'main',
      prNumber: null,
      sha,
      strategy: strategyOf(app.buildStrategy),
      publish,
      requestedBy: 'sweep',
    },
    now,
  )
  if (outcome === 'enqueued') {
    console.info(
      `[builds] sweep: enqueued ${app.name} ${sha.slice(0, 7)} (${target.defaultBranch} HEAD, not built)`,
    )
    record.enqueued.push(app.name)
  }
  return null
}
