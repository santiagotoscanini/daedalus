import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { imageVersion, type RunningVersion } from '../../../lib/dashboard/images'

// The Probes tab: gatus, read through prometheus — what is not answering
// now, the worst 7-day uptimes, the slowest endpoints, the soonest cert.

export type ProbesData = {
  up: number | null
  down: number | null
  uptime24h: number | null
  /** Not answering right now, named. */
  failing: string[]
  /** Lowest 7-day uptime — ascending, because the bottom is the point. */
  worst: { name: string; uptime: number }[]
  slowest: { label: string; value: number; display: string }[]
  /** Soonest certificate expiry, and which hostname it belongs to. */
  cert: { days: number | null; host: string | null }
  /**
   * From the image, because gatus serves no version anywhere.
   *
   * `/api/v1/config` is the only unauthenticated endpoint it publishes and it
   * answers with three booleans about the login form. So the pin is the whole
   * answer here, and the page says so rather than presenting it as a reading.
   */
  running: RunningVersion
  gap: VersionGap
}

export async function loadProbes(ctx: Ctx): Promise<ProbesData> {
  const running = await imageVersion('gatus')
  const [totals, current, worst, slowest, certs, gap] = await Promise.all([
    ctx.prom.scalars({
      up: 'count(gatus_results_endpoint_success == 1) or vector(0)',
      down: 'count(gatus_results_endpoint_success == 0) or vector(0)',
      uptime: '100 * avg(avg_over_time(gatus_results_endpoint_success[24h]))',
    }),
    ctx.prom.vector('gatus_results_endpoint_success == 0'),
    ctx.prom.vector('bottomk(8, 100 * avg_over_time(gatus_results_endpoint_success[7d]))'),
    ctx.prom.bars('topk(8, gatus_results_duration_seconds)', 'name'),
    ctx.prom.vector('bottomk(1, gatus_results_certificate_expiration_seconds)'),
    versionGap('TwiN/gatus', running.version),
  ])

  const soonest = certs[0]

  return {
    running,
    gap,
    up: totals.up,
    down: totals.down,
    uptime24h: totals.uptime,
    failing: current.map((c) => c.metric.name ?? '?').sort((a, b) => a.localeCompare(b)),
    // Re-sorted ascending: promVector preserves prometheus's order, and the
    // whole reason for a bottomk is to read the bad end first.
    worst: worst
      .map((r) => ({ name: r.metric.name ?? '?', uptime: Number(r.value[1]) }))
      .filter((r) => Number.isFinite(r.uptime))
      .sort((a, b) => a.uptime - b.uptime),
    slowest: slowest.map((s) => ({ ...s, display: `${(s.value * 1000).toFixed(0)} ms` })),
    cert: {
      days: soonest === undefined ? null : Number(soonest.value[1]) / 86400,
      host: soonest?.metric.name ?? null,
    },
  }
}
