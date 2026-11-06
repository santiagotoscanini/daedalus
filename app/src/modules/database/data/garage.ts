import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'

/* ── Garage ───────────────────────────────────────────────────────────── */

/**
 * The shared object store, which every app with Object storage on is a tenant
 * of: one bucket and one access key each.
 *
 * Pure prometheus, like the Postgres tab. Garage exports its cluster, API and
 * block metrics itself; what it does NOT export is anything per bucket — that
 * lives only in its admin API — so nix/modules/garage copies each bucket's
 * usage into node-exporter's textfile collector every five minutes
 * (`garage_bucket_*`). The page never holds an admin credential.
 */
export type GarageData = {
  buckets: {
    name: string
    bytes: number
    objects: number | null
    /** Uploads begun and never completed or aborted — a client that died mid-upload. */
    unfinishedUploads: number | null
    unfinishedBytes: number | null
    quotaBytes: number | null
    /** Keys holding any permission. A tenant's bucket has exactly one. */
    keys: number | null
  }[]
  totals: {
    bytes: number
    objects: number | null
    /** The data volume as Garage sees it. */
    diskAvail: number | null
    diskTotal: number | null
    requestsPerHour: number | null
    errorsPerHour: number | null
    /** Blocks Garage cannot read or resync. With one copy each, an object it cannot serve. */
    erroredBlocks: number | null
    resyncQueue: number | null
  }
  /** `cluster_available`: what /health answers 503 on. Null = no scrape at all. */
  available: boolean | null
  /** Age of the bucket figures, seconds — they are copied, not scraped. */
  bucketsAge: number | null
  version: string | null
  gap: VersionGap
  /** The LAN S3 endpoint and the web console. */
  s3Url: string
  consoleUrl: string
}

export async function loadGarage(ctx: Pick<Ctx, 'hosts' | 'prom'>): Promise<GarageData> {
  const [bytes, objects, unfinished, unfinishedBytes, quotas, keys, scalars, info] =
    await Promise.all([
      ctx.prom.vector('garage_bucket_bytes'),
      ctx.prom.vector('garage_bucket_objects'),
      ctx.prom.vector('garage_bucket_unfinished_uploads'),
      ctx.prom.vector('garage_bucket_unfinished_upload_bytes'),
      ctx.prom.vector('garage_bucket_quota_bytes'),
      ctx.prom.vector('garage_bucket_keys'),
      ctx.prom.scalars({
        available: 'max(cluster_available{job="garage"})',
        diskAvail: 'max(garage_local_disk_avail{job="garage",volume="data"})',
        diskTotal: 'max(garage_local_disk_total{job="garage",volume="data"})',
        requests: 'sum(rate(api_s3_request_counter{job="garage"}[1h])) * 3600',
        errors: 'sum(rate(api_s3_error_counter{job="garage",status_code=~"5.."}[1h])) * 3600',
        erroredBlocks: 'max(block_resync_errored_blocks{job="garage"})',
        resyncQueue: 'max(block_resync_queue_length{job="garage"})',
        stamp: 'max(garage_bucket_metrics_timestamp_seconds)',
      }),
      ctx.prom.vector('garage_build_info{job="garage"}'),
    ])

  const by = (rows: { metric: Record<string, string>; value: [number, string] }[]) =>
    new Map(rows.map((r) => [r.metric.bucket ?? '', Number(r.value[1])]))
  const ob = by(objects)
  const un = by(unfinished)
  const ub = by(unfinishedBytes)
  const qb = by(quotas)
  const kb = by(keys)

  const buckets = bytes
    .map((r) => {
      const name = r.metric.bucket ?? '?'
      return {
        name,
        bytes: Number(r.value[1]),
        objects: ob.get(name) ?? null,
        unfinishedUploads: un.get(name) ?? null,
        unfinishedBytes: ub.get(name) ?? null,
        quotaBytes: qb.get(name) ?? null,
        keys: kb.get(name) ?? null,
      }
    })
    .sort((a, b) => b.bytes - a.bytes)

  // `v2.5.0` on the build-info label; the release tags are compared bare.
  const version = info[0]?.metric.version?.replace(/^v/, '') ?? null

  return {
    buckets,
    totals: {
      bytes: buckets.reduce((n, b) => n + b.bytes, 0),
      objects: buckets.length === 0 ? null : buckets.reduce((n, b) => n + (b.objects ?? 0), 0),
      diskAvail: scalars.diskAvail,
      diskTotal: scalars.diskTotal,
      requestsPerHour: scalars.requests,
      errorsPerHour: scalars.errors,
      erroredBlocks: scalars.erroredBlocks,
      resyncQueue: scalars.resyncQueue,
    },
    available: scalars.available === null ? null : scalars.available >= 1,
    bucketsAge: scalars.stamp === null ? null : Math.max(0, Date.now() / 1000 - scalars.stamp),
    version,
    // Garage publishes its releases on its own forge; GitHub carries only a
    // mirror of the tags.
    gap: await versionGap('git.deuxfleurs.fr/Deuxfleurs/garage', version),
    s3Url: ctx.hosts.base('s3'),
    consoleUrl: ctx.hosts.base('garage'),
  }
}
