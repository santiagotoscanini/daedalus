import type { Ctx } from '../../core/ctx'
import { type BuilderSnapshot, readBuilderFacts } from '../../host/builder-facts'
import { publicInstallation, readGithubInstallation } from '../../host/github-token'
import { type ImageUpdateStatus, readImageUpdateStatus } from '../../host/image-update'
import type { LiveBuild } from '../build-display'
import { type BuildStats, buildStats } from '../build-stats'
import { type ManualRow, manualRows } from '../dashboard/update-rows'
import { listApps } from '../repo/apps'
import { builderNow, buildsSince, type ReportedBuild, recentReported } from '../repo/build-views'
import { latestDeliveries } from '../repo/github-deliveries'

// Apps › Builder: the box's image builder as one machine — what it is doing
// now, how it has done, what it is built from, the machinery under it and how
// GitHub reaches it. What it has pushed is the Container registry tab beside it.
//
// Each section has its own source and none waits on another's failure: the
// builds are the app's own table, the machinery is daedalus-builder-snapshot
// (host/builder-facts.ts), the toolchain is the manual pins System › Updates
// already lists, GitHub is the webhook's table plus Loki and the App's token.
// A missing or stale snapshot is "unknown" on the page, never a healthy default.

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

export async function loadBuilder(ctx: Ctx): Promise<BuilderData> {
  const since = new Date(Date.now() - HISTORY_DAYS * 24 * 3600_000)
  const [apps, now, rows, manual, status, machinery, github] = await Promise.all([
    listApps(),
    builderNow(),
    buildsSince(since),
    manualRows(),
    readImageUpdateStatus(),
    readBuilderFacts(),
    loadGithub(ctx),
  ])
  return {
    now,
    history: { ...buildStats(rows), days: HISTORY_DAYS },
    toolchain: {
      rows: manual.filter((r) => TOOLCHAIN_PINS.includes(r.container)),
      status,
      apps: apps.map((a) => a.name),
    },
    machinery,
    github,
  }
}
