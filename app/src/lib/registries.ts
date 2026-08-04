// The two registries every app on this box is built out of.
//
// They belong on the Apps page rather than in a category because they are not
// a subject area — they are shared build infrastructure, and their only
// consumer is the app list they sit under. zot holds the images the deploy
// timer pulls; verdaccio holds the npm packages the CI builds resolve. When a
// deploy stops moving, one of these two is usually why.
//
// Both are read through traefik on their published hostnames: daedalus is on a
// private bridge (auth.isolated) and cannot dial them by container DNS the way
// homepage does. The counts that prometheus already scrapes come from
// prometheus, for the usual reason — it is one round trip for a number the box
// is collecting anyway.

import { getJson, promBars, promScalar, promVector } from './dashboard/clients'

export type RegistryData = {
  images: {
    /** Repositories that are apps built here, `cache/*` excluded. */
    repositories: string[]
    /** Pull-through cache entries — upstream images, not ours. */
    cached: number
    storageBytes: number | null
    /** On-disk bytes per repository, largest first. */
    byRepo: { label: string; value: number; display: string }[]
    /** Manifest pulls since zot last started. */
    pulls: { label: string; value: number }[]
    pushes: number | null
    requestsPerHour: number | null
    version: string | null
    reachable: boolean
  }
  packages: {
    published: number | null
    cached: number | null
    versions: number | null
    withTarball: number | null
    multiVersion: number | null
    reachable: boolean
  }
}

export async function loadRegistries(base: (app: string) => string): Promise<RegistryData> {
  const [catalog, storage, pulls, pushes, requests, info, npm] = await Promise.all([
    // Anonymous read is deliberately allowed on zot (stacks/registry), which is
    // what lets this work with no credential at all.
    getJson<{ repositories?: string[] }>(`${base('registry')}/v2/_catalog`),
    promVector('zot_repo_storage_bytes'),
    promBars('sum by (repo) (zot_repo_downloads_total)', 'repo'),
    promScalar('sum(zot_repo_uploads_total)'),
    promScalar('sum(rate(zot_http_requests_total[1h])) * 3600'),
    promVector('zot_info'),
    // Served by the cached-packages plugin (stacks/verdaccio/assets):
    // verdaccio's own /-/v1/search saturates at that endpoint's 250-result cap
    // and cannot tell a package published here from one pulled off npmjs.
    getJson<{
      published?: number
      cached?: number
      cachedVersions?: number
      cachedWithTarball?: number
      multiVersion?: number
    }>(`${base('verdaccio')}/-/cached-packages/stats`),
  ])

  const repos = catalog?.repositories ?? []
  const byRepo = storage
    .map((r) => ({ label: r.metric.repo ?? '?', value: Number(r.value[1]) }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => b.value - a.value)

  return {
    images: {
      // `cache/<app>` is the pull-through copy of an upstream base image, not
      // something built here. Counting them together would report four
      // repositories for two apps.
      repositories: repos.filter((r) => !r.startsWith('cache/')),
      cached: repos.filter((r) => r.startsWith('cache/')).length,
      storageBytes: byRepo.length === 0 ? null : byRepo.reduce((n, r) => n + r.value, 0),
      byRepo: byRepo.map((r) => ({ ...r, display: fmtBytes(r.value) })),
      pulls,
      pushes,
      requestsPerHour: requests,
      // zot reports its build as a label on a zero-valued info gauge; the
      // `commit` label carries the real version, `version` is the metadata
      // schema's.
      version: info[0]?.metric.commit?.split('-')[0] ?? null,
      reachable: catalog !== null,
    },
    packages: {
      published: npm?.published ?? null,
      cached: npm?.cached ?? null,
      versions: npm?.cachedVersions ?? null,
      withTarball: npm?.cachedWithTarball ?? null,
      multiVersion: npm?.multiVersion ?? null,
      reachable: npm !== null,
    },
  }
}

// A local copy rather than an import from dashboard/format: that module is the
// category pages' formatter and this one number is the only reason this file
// would depend on it.
function fmtBytes(v: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = v
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n.toFixed(n >= 10 || u === 0 ? 0 : 1)} ${units[u] ?? 'B'}`
}
