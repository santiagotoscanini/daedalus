import { makeCtx } from '../../core/ctx'
import { repoFileExists } from '../../core/github-app'
import { listRepos } from '../../host/github-repos'
import { manifestEntries } from '../../host/nix-manifest'
import { imageInfo } from '../../host/registry'
import { swrCache } from '../cache'
import type { RepoBuild } from '../readiness'
import { listApps } from '../repo/apps'
import { defaultImage, OWNER, REGISTRY_HOST_PATTERN } from '../site'

// The reads behind the create form: what it can be pointed at, whether the
// image it would produce exists yet, and what the repository says about how it
// wants to be built.

/**
 * What the create form needs before it can ask anything: the repositories to
 * pick from, and the names already spoken for.
 *
 * The repo list is the slow half (a GitHub round trip, as the App installation
 * — host/github-repos.ts) and the taken names are two file reads plus a query,
 * but they are fetched together: the form cannot usefully render half of
 * itself, since picking a repo is what every later step keys off.
 */
export async function loadNewAppOptions() {
  const [repos, records, manifest] = await Promise.all([listRepos(), listApps(), manifestEntries()])

  // A name is taken if EITHER source knows it: the database holds what
  // daedalus manages, the manifest additionally holds the hand-written
  // entries. The picker greys those repos out rather than letting the create
  // fail at the last step.
  const taken = [...new Set([...records.map((r) => r.name), ...manifest.map((m) => m.name)])]

  return { taken, ...repos }
}

/**
 * Short-lived, because the form asks on every keystroke.
 *
 * The debounce in the create page separates typing from asking, but editing
 * the image override still re-runs the whole preflight, and the repo's build
 * configuration has nothing to do with the image. Fifteen seconds is long
 * enough that a burst of typing costs one GitHub round trip and short enough
 * that "Re-run the checks" after committing a railpack.json means what it
 * says on the second press.
 */
const REPO_BUILD = swrCache({ ttlMs: 15_000 })

/**
 * How the box would build this repo: its railpack.json, else its Dockerfile,
 * else nothing — in which case Railpack falls back to zero-config detection.
 *
 * Read through the GitHub App's `contents:read`. Reported, never enforced: a
 * repo with neither file is a warning on the form, because Railpack CAN build
 * one, and refusing to create the entry over it would be the same mistake the
 * image gate was.
 */
async function repoBuild(name: string): Promise<RepoBuild> {
  return REPO_BUILD.get(name, async () => {
    // `OWNER/<app name>` — the same assumption the build service, the detail
    // page and the default image all make: an app is its repository's name.
    const fullName = `${OWNER}/${name}`
    const ctx = await makeCtx()
    const railpack = await repoFileExists(ctx, fullName, 'railpack.json')
    if (railpack === 'present') return 'railpack'
    if (railpack === 'unknown') return 'unknown'
    const dockerfile = await repoFileExists(ctx, fullName, 'Dockerfile')
    return dockerfile === 'present' ? 'dockerfile' : dockerfile === 'absent' ? 'none' : 'unknown'
  })
}

/**
 * What the form reports before it offers to create the entry: whether the
 * image exists yet, and how the repo would be built.
 *
 * Neither is a gate any more. The image gate existed because an entry whose
 * image does not exist declares a container that cannot pull, which fails the
 * switch and reverts the Apply — and the `declared` stage is what actually
 * fixes that, since a declared app runs nothing to fail. Being in
 * site/apps.json is what earns the app its first build, so the entry has to
 * come first.
 */
export async function appPreflight(data: { name: string; image: string | null }) {
  const effectiveImage = data.image?.trim() || defaultImage(data.name)

  // Only images on the box's own zot can be verified from here — an override
  // pointing at GHCR or docker.io is reported as unverified rather than
  // guessed at, because a wrong "missing" would block a legitimate fork.
  // `<repo>` then an optional `:tag` or `@digest`; the leading separator is
  // dropped either way, since the manifest endpoint takes both as a bare
  // reference.
  const local = new RegExp(`^${REGISTRY_HOST_PATTERN}/(?<repo>[^:@]+)(?<ref>[:@].+)?$`).exec(
    effectiveImage,
  )
  // Two independent upstreams — the box's own zot and GitHub — so they are
  // asked together rather than one behind the other.
  const [imageState, build] = await Promise.all([
    local?.groups?.repo === undefined
      ? Promise.resolve('unverifiable' as const)
      : imageInfo(local.groups.repo, (local.groups.ref ?? ':latest').slice(1)).then((info) =>
          info.digest === null ? ('missing' as const) : ('present' as const),
        ),
    repoBuild(data.name),
  ])

  return { effectiveImage, imageState, repoBuild: build }
}
