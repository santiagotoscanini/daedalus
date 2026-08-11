// The two registries every app on this box is built out of.
//
// They belong under Apps rather than in a category of their own because they
// are not a subject area — they are shared build infrastructure, and their
// only consumer is the app list beside them. zot holds the images the deploy
// timer pulls; verdaccio holds the npm packages the CI builds resolve. When a
// deploy stops moving, one of these two is usually why.
//
// A loader per registry rather than one for both: they are separate tabs now,
// and a tab should not wait on the other one's upstream to render.
//
// Both are read through traefik on their published hostnames: daedalus sits on
// a private bridge (auth.isolated), so it cannot dial them by container DNS.
// The counts that prometheus already scrapes come from prometheus, for the
// usual reason — it is one round trip for a number the box is collecting
// anyway.

import { getJson, promBars, promScalar, promVector } from './dashboard/clients'
import { type VersionGap, versionGap } from './dashboard/github'
import { imageVersion, type RunningVersion } from './dashboard/images'

export type ImagesData = {
  /** Repositories that are apps built here, `cache/*` excluded. */
  repositories: string[]
  /** Pull-through cache entries — upstream images, not ours. */
  cachedRepos: string[]
  storageBytes: number | null
  /** On-disk bytes per repository, largest first. */
  byRepo: { label: string; value: number; display: string }[]
  /** Manifest pulls since zot last started. */
  pulls: { label: string; value: number }[]
  pushes: number | null
  requestsPerHour: number | null
  errorsPerHour: number | null
  version: string | null
  gap: VersionGap
  reachable: boolean
}

export type PackagesData = {
  published: number | null
  cached: number | null
  versions: number | null
  withTarball: number | null
  multiVersion: number | null
  /** Requests through traefik — verdaccio publishes no metrics of its own. */
  requestsPerHour: number | null
  errorsPerHour: number | null
  running: RunningVersion
  gap: VersionGap
  reachable: boolean
}

export async function loadImages(base: (app: string) => string): Promise<ImagesData> {
  const [catalog, storage, pulls, pushes, requests, errors, info] = await Promise.all([
    // Anonymous read is deliberately allowed on zot (stacks/registry), which is
    // what lets this work with no credential at all.
    getJson<{ repositories?: string[] }>(`${base('registry')}/v2/_catalog`),
    promVector('zot_repo_storage_bytes'),
    promBars('sum by (repo) (zot_repo_downloads_total)', 'repo'),
    promScalar('sum(zot_repo_uploads_total)'),
    promScalar('sum(rate(zot_http_requests_total[1h])) * 3600'),
    promScalar('sum(rate(zot_http_requests_total{code=~"5.."}[1h])) * 3600'),
    promVector('zot_info'),
  ])

  const repos = catalog?.repositories ?? []
  const byRepo = storage
    .map((r) => ({ label: r.metric.repo ?? '?', value: Number(r.value[1]) }))
    .filter((r) => Number.isFinite(r.value))
    .sort((a, b) => b.value - a.value)

  // zot reports its build as a label on a zero-valued info gauge; the `commit`
  // label carries the real version, `version` is the metadata schema's.
  const version = info[0]?.metric.commit?.split('-')[0] ?? null

  return {
    // `cache/<app>` is the pull-through copy of an upstream base image, not
    // something built here. Counting them together would report four
    // repositories for two apps.
    repositories: repos.filter((r) => !r.startsWith('cache/')),
    cachedRepos: repos.filter((r) => r.startsWith('cache/')),
    storageBytes: byRepo.length === 0 ? null : byRepo.reduce((n, r) => n + r.value, 0),
    byRepo: byRepo.map((r) => ({ ...r, display: fmtBytes(r.value) })),
    pulls,
    pushes,
    requestsPerHour: requests,
    errorsPerHour: errors,
    version,
    gap: await versionGap('project-zot/zot', version),
    reachable: catalog !== null,
  }
}

export async function loadPackages(base: (app: string) => string): Promise<PackagesData> {
  const [npm, requests, errors, running] = await Promise.all([
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
    // From traefik, not from verdaccio: it has no prometheus endpoint at all
    // (upstream #1815, stale since 2020), which is also why its Grafana
    // dashboard is built out of proxy metrics.
    promScalar('sum(rate(traefik_service_requests_total{service=~"verdaccio.*"}[1h])) * 3600'),
    promScalar(
      'sum(rate(traefik_service_requests_total{service=~"verdaccio.*",code=~"5.."}[1h])) * 3600',
    ),
    // The image is built here (mkLocalImage), so the running version is the
    // tag nix pinned rather than anything the container reports.
    imageVersion('verdaccio'),
  ])

  return {
    published: npm?.published ?? null,
    cached: npm?.cached ?? null,
    versions: npm?.cachedVersions ?? null,
    withTarball: npm?.cachedWithTarball ?? null,
    multiVersion: npm?.multiVersion ?? null,
    requestsPerHour: requests,
    errorsPerHour: errors,
    running,
    gap: await versionGap('verdaccio/verdaccio', running.version),
    reachable: npm !== null,
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
