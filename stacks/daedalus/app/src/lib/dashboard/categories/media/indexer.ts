import { getJson } from '../../../http'
import { key } from '../../../keys'
import { type VersionGap, versionGap } from '../../github'
import { ARR_TAG, type Ctx } from './shared'
import type { ArrData } from './wanted'

/* ── Prowlarr ─────────────────────────────────────────────────────────── */

export type ProwlarrData = {
  version: string | null
  gap: VersionGap
  health: ArrData['health']
  counts: { enabled: number | null; disabled: number | null }
  /** Busiest first. */
  indexers: {
    name: string
    enabled: boolean
    protocol: string
    queries: number
    grabs: number
    failedQueries: number
    failedGrabs: number
    /** Milliseconds. Null when it has never been asked. */
    responseMs: number | null
  }[]
}

export async function loadProwlarr(ctx: Ctx): Promise<ProwlarrData> {
  const base = `${ctx.hc}:9696/api/v1`
  const k = `apikey=${key('PROWLARR_API_KEY')}`

  const [status, health, stats, indexers] = await Promise.all([
    getJson<{ version?: string }>(`${base}/system/status?${k}`),
    getJson<{ type?: string; source?: string; message?: string; wikiUrl?: string }[]>(
      `${base}/health?${k}`,
    ),
    getJson<{
      indexers?: {
        indexerName?: string
        numberOfQueries?: number
        numberOfGrabs?: number
        numberOfFailedQueries?: number
        numberOfFailedGrabs?: number
        averageResponseTime?: number
      }[]
    }>(`${base}/indexerstats?${k}`),
    getJson<{ name?: string; enable?: boolean; protocol?: string }[]>(`${base}/indexer?${k}`),
  ])

  const version = status?.version ?? null
  const byName = new Map((indexers ?? []).map((i) => [i.name ?? '', i]))

  return {
    version,
    gap: await versionGap('Prowlarr/Prowlarr', version, { tag: ARR_TAG }),
    health: (health ?? [])
      .filter((h) => h.type === 'warning' || h.type === 'error')
      .map((h) => ({
        level: h.type === 'error' ? ('bad' as const) : ('warn' as const),
        source: (h.source ?? '').replace(/Check$/, ''),
        message: h.message ?? '',
        url: h.wikiUrl ?? null,
      })),
    counts: {
      enabled: indexers === null ? null : indexers.filter((i) => i.enable === true).length,
      disabled: indexers === null ? null : indexers.filter((i) => i.enable !== true).length,
    },
    indexers: (stats?.indexers ?? [])
      .map((s) => {
        const name = s.indexerName ?? '?'
        const meta = byName.get(name)
        return {
          name,
          // An indexer with stats and no entry in the list has been deleted
          // since those queries were counted; it is not enabled.
          enabled: meta?.enable === true,
          protocol: meta?.protocol ?? 'unknown',
          queries: s.numberOfQueries ?? 0,
          grabs: s.numberOfGrabs ?? 0,
          failedQueries: s.numberOfFailedQueries ?? 0,
          failedGrabs: s.numberOfFailedGrabs ?? 0,
          responseMs: s.averageResponseTime ?? null,
        }
      })
      .sort((a, b) => b.queries - a.queries),
  }
}
