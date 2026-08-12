import { promScalar, promScalars, promVector } from '../../../prom'
import type { VersionGap } from '../../github'
import { postgresGap } from '../../postgres'

/* ── Database ─────────────────────────────────────────────────────────── */

/**
 * The shared Postgres cluster, which every app on this box is a tenant of.
 *
 * postgres_exporter already publishes all of this and nothing read it — the
 * old page showed the top eight databases by size and stopped, which answers
 * "what is big" and none of the questions you actually have about a cluster:
 * whether it is serving from cache, whether anything is stuck in a
 * transaction, whether a tenant is rolling back more than it commits.
 */
export type DatabaseData = {
  databases: {
    name: string
    sizeBytes: number
    connections: number | null
    /** Buffer-cache hit rate. Below ~99% on a box this size means seeks. */
    cacheHitPct: number | null
    commits: number | null
    rollbacks: number | null
    deadlocks: number | null
  }[]
  totals: {
    sizeBytes: number
    connections: number | null
    maxConnections: number | null
    /** Longest running transaction, seconds. The stuck-query signal. */
    longestTxSeconds: number | null
    locks: number | null
    tempBytes: number | null
  }
  version: string | null
  up: boolean | null
  /**
   * The release gap, from postgresql.org rather than GitHub.
   *
   * The mirror at postgres/postgres carries tags and publishes no releases, so
   * the usual `versionGap` would report the one service on this box whose
   * minors are almost purely security fixes as having no notes at all. See
   * ../postgres.ts.
   */
  gap: VersionGap
}

export async function loadDatabase(): Promise<DatabaseData> {
  const [sizes, conns, hits, reads, commits, rollbacks, deadlocks, totals, up] = await Promise.all([
    promVector('pg_database_size_bytes'),
    promVector('pg_stat_database_numbackends'),
    promVector('pg_stat_database_blks_hit'),
    promVector('pg_stat_database_blks_read'),
    promVector('pg_stat_database_xact_commit'),
    promVector('pg_stat_database_xact_rollback'),
    promVector('pg_stat_database_deadlocks'),
    promScalars({
      connections: 'sum(pg_stat_activity_count)',
      maxConnections: 'pg_settings_max_connections',
      longestTx: 'max(pg_stat_activity_max_tx_duration)',
      locks: 'sum(pg_locks_count)',
      temp: 'sum(pg_stat_database_temp_bytes)',
    }),
    promScalar('pg_up'),
  ])

  const version = await pgVersion()

  const by = (rows: { metric: Record<string, string>; value: [number, string] }[]) =>
    new Map(rows.map((r) => [r.metric.datname ?? '', Number(r.value[1])]))
  const c = by(conns)
  const h = by(hits)
  const rd = by(reads)
  const cm = by(commits)
  const rb = by(rollbacks)
  const dl = by(deadlocks)

  const databases = sizes
    .map((s) => {
      const name = s.metric.datname ?? '?'
      const hit = h.get(name)
      const read = rd.get(name)
      return {
        name,
        sizeBytes: Number(s.value[1]),
        connections: c.get(name) ?? null,
        cacheHitPct:
          hit === undefined || read === undefined || hit + read === 0
            ? null
            : (hit / (hit + read)) * 100,
        commits: cm.get(name) ?? null,
        rollbacks: rb.get(name) ?? null,
        deadlocks: dl.get(name) ?? null,
      }
    })
    // Postgres's own three are real databases and appear in every metric, but
    // they are not tenants and their presence at the top of a size-ordered
    // list is noise.
    .filter((d) => !['template0', 'template1'].includes(d.name))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)

  return {
    databases,
    totals: {
      sizeBytes: databases.reduce((n, d) => n + d.sizeBytes, 0),
      connections: totals.connections,
      maxConnections: totals.maxConnections,
      longestTxSeconds: totals.longestTx,
      locks: totals.locks,
      tempBytes: totals.temp,
    },
    version,
    gap: await postgresGap(version),
    up: up === null ? null : up === 1,
  }
}

async function pgVersion(): Promise<string | null> {
  const rows = await promVector('pg_static')
  const v = rows[0]?.metric.short_version ?? rows[0]?.metric.version ?? null
  return v === null ? null : v.split(' ').slice(0, 2).join(' ')
}
