import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { hostFacts, type JobRun } from '../../../lib/dashboard/host-facts'
import { imageVersion, type RunningVersion } from '../../../lib/dashboard/images'
import { getJson } from '../../../lib/http'
import { TWO_OR_THREE } from '../../../lib/release-tags'

// The Jobs tab: healthchecks' roster joined to the monitoredJobs registry and
// the host's timer table. The fetches are loadJobs; the join and the ranking
// are the pure `joinJobs` and `rankChecks` beneath it.

/**
 * Every scheduled job, and whether anything would notice it stopping.
 *
 * This is the tab that gains most from the split, because the two halves of
 * the answer used to live on different pages: healthchecks' roster was a tile
 * here, and the registry that says which jobs were MEANT to be watched was
 * nowhere at all. Joined, the interesting row is a job declared with a
 * healthchecks slug that healthchecks has never heard of — a dead-man's-switch
 * that was armed in nix and never fired once.
 *
 * The distinction the registry carries and neither system knows:
 *   - `email`  → a run that FAILS sends mail.
 *   - `slug`   → a run that stops HAPPENING pages through healthchecks.
 * A job with mail and no slug cannot report that it was never started, which
 * is the failure mode a timer actually has.
 */
export type JobsData = {
  checks: {
    name: string
    status: string
    lastPingAgo: number | null
    dueIn: number | null
    pings: number
  }[]
  summary: { up: number; down: number; late: number } | null
  jobs: {
    unit: string
    email: boolean
    slug: string | null
    /** Its healthchecks row, when the slug resolves to one. */
    status: string | null
    lastPingAgo: number | null
    /**
     * The OUTCOME, from the host snapshot's timer table — what actually
     * happened, next to the two columns about what would be noticed. Null
     * throughout for a job with no timer (boot oneshots, path units): their
     * absence from the timer list is itself information, so the row stays
     * and the columns read as dashes.
     */
    lastRunAgo: number | null
    result: string | null
    exitStatus: number | null
    nextIn: number | null
  }[]
  /** Timers running on the box that no monitoredJobs entry watches. */
  unwatchedTimers: number
  /** Declared with a slug that healthchecks does not know. */
  orphaned: string[]
  /** Watched by mail only — cannot report never having run. */
  emailOnly: number
  /** From the image: healthchecks' API is about checks, not about itself. */
  running: RunningVersion
  gap: VersionGap
}

type HcCheck = {
  name?: string
  slug?: string
  status?: string
  last_ping?: string | null
  next_ping?: string | null
  n_pings?: number
}

/** One entry of the monitoredJobs registry (`host/nix-manifest.ts`). */
type RegisteredJob = { unit: string; email: boolean; slug: string | null }

export async function loadJobs(ctx: Ctx): Promise<JobsData> {
  const { monitoredJobs } = await import('../../../host/nix-manifest')
  const running = await imageVersion('healthchecks')

  const [body, registry, gap, facts] = await Promise.all([
    getJson<{ checks?: HcCheck[] }>(`${ctx.hosts.base('healthchecks')}/api/v1/checks/`, {
      headers: { 'X-Api-Key': ctx.secret('HEALTHCHECKS_API_KEY') },
    }),
    monitoredJobs(),
    // healthchecks numbers its releases with two segments — `v4.2`, `v4.1.1`
    // — so the default three-segment pattern matches none of them and would
    // report a project with 60 published releases as having none at all.
    versionGap('healthchecks/healthchecks', running.version, { tag: TWO_OR_THREE }),
    hostFacts(),
  ])

  const now = Date.now()
  const checks = body?.checks
  const jobs = joinJobs(registry, checks, facts.jobs, now)

  return {
    running,
    gap,
    summary:
      checks === undefined
        ? null
        : {
            up: checks.filter((c) => c.status === 'up').length,
            down: checks.filter((c) => c.status === 'down').length,
            late: checks.filter((c) => c.status === 'grace').length,
          },
    checks: rankChecks(checks ?? [], now),
    orphaned: jobs.filter((j) => j.slug !== null && j.status === null).map((j) => j.unit),
    emailOnly: jobs.filter((j) => j.slug === null).length,
    unwatchedTimers: facts.jobs.filter((r) => {
      const base = r.timer.replace(/\.timer$/, '')
      return !registry.some((j) => j.unit === base)
    }).length,
    jobs,
  }
}

/** Seconds since an ISO timestamp healthchecks reported; null when it reported none. */
function ageOf(iso: string | null | undefined, now: number): number | null {
  return iso === null || iso === undefined ? null : (now - Date.parse(iso)) / 1000
}

/**
 * The registry's jobs, each joined to its healthchecks row (by slug) and its
 * last timer run (by unit) — the three views of one job side by side.
 */
function joinJobs(
  registry: readonly RegisteredJob[],
  checks: readonly HcCheck[] | undefined,
  runs: readonly JobRun[],
  now: number,
): JobsData['jobs'] {
  // Keyed by slug AND by name: healthchecks derives a slug from the name, and
  // the registry declares the slug, so matching on either survives a check
  // whose display name was edited in the UI.
  const bySlug = new Map<string, HcCheck>()
  for (const c of checks ?? []) {
    if (c.slug !== undefined) bySlug.set(c.slug, c)
    if (c.name !== undefined) bySlug.set(c.name, c)
  }

  // The registry names bare units ("minecraft-backup"); the snapshot names
  // real ones ("minecraft-backup.timer" activating "…-backup.service").
  // Indexed under both stripped forms so a job matches whichever side of the
  // timer→service pair shares its name.
  const runByUnit = new Map<string, JobRun>()
  for (const r of runs) {
    runByUnit.set(r.timer.replace(/\.timer$/, ''), r)
    if (r.service !== null) runByUnit.set(r.service.replace(/\.service$/, ''), r)
  }

  return (
    [...registry]
      .map((j) => {
        const hit = j.slug === null ? undefined : bySlug.get(j.slug)
        const run = runByUnit.get(j.unit)
        return {
          unit: j.unit,
          email: j.email,
          slug: j.slug,
          status: hit?.status ?? null,
          lastPingAgo: ageOf(hit?.last_ping, now),
          lastRunAgo: run === undefined || run.lastAt === null ? null : now / 1000 - run.lastAt,
          // Meaningless without a run to describe — systemd defaults them to
          // success/0 on a service that never started.
          result: run === undefined || run.lastAt === null ? null : run.result,
          exitStatus: run === undefined || run.lastAt === null ? null : run.exitStatus,
          nextIn: run?.nextAt === undefined || run.nextAt === null ? null : run.nextAt - now / 1000,
        }
      })
      // Jobs with a live dead-man's-switch first, then the mail-only ones —
      // which is the order of how much is actually known about each.
      .sort(
        (a, b) => Number(b.slug !== null) - Number(a.slug !== null) || a.unit.localeCompare(b.unit),
      )
  )
}

/** healthchecks' roster as rows, in the order you would read them to decide whether to act. */
function rankChecks(checks: readonly HcCheck[], now: number): JobsData['checks'] {
  return (
    checks
      .map((c) => ({
        name: c.name ?? '?',
        status: c.status ?? 'unknown',
        lastPingAgo: ageOf(c.last_ping, now),
        // Negative means the window has already passed — the check is overdue
        // but still inside its grace period, which is precisely the state
        // worth seeing before it turns into an alert.
        dueIn:
          c.next_ping === null || c.next_ping === undefined
            ? null
            : (Date.parse(c.next_ping) - now) / 1000,
        pings: c.n_pings ?? 0,
      }))
      // Anything not "up" first, then soonest due — the order you would read
      // them in if you were deciding whether to act.
      .sort((a, b) => {
        const rank = (s: string) => (s === 'down' ? 0 : s === 'grace' ? 1 : 2)
        return rank(a.status) - rank(b.status) || (a.dueIn ?? Infinity) - (b.dueIn ?? Infinity)
      })
  )
}
