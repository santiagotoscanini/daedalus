import type { Ctx } from '../../../core/ctx'
import { type BuilderSnapshot, readBuilderFacts } from '../../../host/builder-facts'
import { publicInstallation, readGithubInstallation } from '../../../host/github-token'
import { type ImageUpdateStatus, readImageUpdateStatus } from '../../../host/image-update'
import type { LiveBuild } from '../../../lib/build-display'
import { type BuildStats, buildStats } from '../../../lib/build-stats'
import { type ManualRow, manualRows } from '../../../lib/dashboard/update-rows'
import { listApps } from '../../../lib/repo/apps'
import {
  builderNow,
  buildsSince,
  type ReportedBuild,
  recentReported,
} from '../../../lib/repo/build-views'
import { latestDeliveries } from '../../../lib/repo/github-deliveries'

// System › Builder: the box's image builder as one machine — what it is doing
// now, how it has done, what it is built from, the machinery under it, how
// GitHub reaches it, and what it has pushed.
//
// Each section has its own source and none waits on another's failure: the
// builds are the app's own table, the machinery is daedalus-builder-snapshot
// (host/builder-facts.ts), the toolchain is the manual pins System › Updates
// already lists, GitHub is the webhook's table plus Loki and the App's token,
// the registry is zot's catalog and its prometheus sizes. A missing or stale
// snapshot is "unknown" on the page, never a healthy default.

/** How far back History looks. */
const HISTORY_DAYS = 30

/** The manual pins that ARE the build toolchain (railpack.nix, build-agent.nix). */
const TOOLCHAIN_PINS = ['railpack', 'build-checks-node']

export type Delivery = {
  id: string
  event: string
  action: string | null
  outcome: string
  receivedAt: string
}

export type RegistryRepo = { name: string; bytes: number | null }

export type BuilderData = {
  now: LiveBuild[]
  history: BuildStats & { days: number }
  toolchain: {
    rows: ManualRow[]
    /** For ImageRow; no button on these rows moves anything. */
    status: ImageUpdateStatus
    /** The apps on this box, to tell an app's mise cache from a leftover. */
    apps: string[]
  }
  machinery: BuilderSnapshot
  github: {
    deliveries: Delivery[]
    /** Pushes refused for a bad signature in 24 h; null when Loki did not answer. */
    rejected24h: number | null
    installation: (ReturnType<typeof publicInstallation> & { stale: boolean }) | null
    /** The installation token's core budget; null without a token or an answer. */
    rateLimit: { limit: number; remaining: number; resetAt: string } | null
    reported: ReportedBuild[]
  }
  registry: {
    reachable: boolean
    /** Repositories named after an app on this box. */
    apps: RegistryRepo[]
    /** Repositories no app on this box is named after. */
    orphans: RegistryRepo[]
    /** `cache/*`: the pull-through copies of the bases the builds start from. */
    cache: { count: number; bytes: number | null }
  }
}

type RateLimitBody = {
  resources?: { core?: { limit?: number; remaining?: number; reset?: number } }
}

async function loadGithub(ctx: Ctx): Promise<BuilderData['github']> {
  const [deliveries, rejected, installation, limits, reported] = await Promise.all([
    latestDeliveries(5),
    ctx.loki.scalar(
      'sum(count_over_time({container="app-daedalus"} |= "[github-webhook] bad signature" [24h]))',
    ),
    readGithubInstallation(),
    // Free: GitHub does not count /rate_limit against the budget it reports.
    ctx.github.app<RateLimitBody>('/rate_limit'),
    recentReported(10),
  ])
  const core = limits.status === 200 ? limits.body?.resources?.core : undefined
  return {
    deliveries: deliveries.map((d) => ({ ...d, receivedAt: d.receivedAt.toISOString() })),
    rejected24h: rejected,
    installation: installation.available
      ? { ...publicInstallation(installation.data), stale: installation.stale }
      : null,
    rateLimit:
      core?.limit === undefined || core.remaining === undefined
        ? null
        : {
            limit: core.limit,
            remaining: core.remaining,
            resetAt: core.reset === undefined ? '' : new Date(core.reset * 1000).toISOString(),
          },
    reported,
  }
}

async function loadRegistry(
  ctx: Ctx,
  names: ReadonlySet<string>,
): Promise<BuilderData['registry']> {
  const [catalog, storage] = await Promise.all([
    // Anonymous read is allowed on zot (nix/modules/registry), as Apps › Registry relies on.
    ctx.http.getJson<{ repositories?: string[] }>(`${ctx.hosts.base('registry')}/v2/_catalog`),
    ctx.prom.vector('zot_repo_storage_bytes'),
  ])
  const size = new Map<string, number>()
  for (const r of storage) {
    const v = Number(r.value[1])
    if (r.metric.repo !== undefined && Number.isFinite(v)) size.set(r.metric.repo, v)
  }
  const repos = catalog?.repositories ?? []
  const own = repos.filter((r) => !r.startsWith('cache/'))
  const cached = repos.filter((r) => r.startsWith('cache/'))
  const repo = (name: string): RegistryRepo => ({ name, bytes: size.get(name) ?? null })
  const bySize = (a: RegistryRepo, b: RegistryRepo) => (b.bytes ?? 0) - (a.bytes ?? 0)
  const cacheSizes = cached.map((r) => size.get(r)).filter((v) => v !== undefined)
  return {
    reachable: catalog !== null,
    apps: own
      .filter((r) => names.has(r))
      .map(repo)
      .sort(bySize),
    orphans: own
      .filter((r) => !names.has(r))
      .map(repo)
      .sort(bySize),
    cache: {
      count: cached.length,
      bytes: cacheSizes.length === 0 ? null : cacheSizes.reduce((n, v) => n + v, 0),
    },
  }
}

export async function loadBuilder(ctx: Ctx): Promise<BuilderData> {
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 3600_000)
  const names = new Set((await listApps()).map((a) => a.name))
  const [now, rows, manual, status, machinery, github, registry] = await Promise.all([
    builderNow(),
    buildsSince(since),
    manualRows(),
    readImageUpdateStatus(),
    readBuilderFacts(),
    loadGithub(ctx),
    loadRegistry(ctx, names),
  ])
  return {
    now,
    history: { ...buildStats(rows), days: HISTORY_DAYS },
    toolchain: {
      rows: manual.filter((r) => TOOLCHAIN_PINS.includes(r.container)),
      status,
      apps: [...names],
    },
    machinery,
    github,
    registry,
  }
}
