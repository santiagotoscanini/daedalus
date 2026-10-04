import { buildNow } from '../../core/builds/actions'
import { linkAppRepo, type RepoLink } from '../../core/builds/link'
import type { Ctx } from '../../core/ctx'
import { repoFileExists } from '../../core/github-app'
import { publishingFacts } from '../../host/contract/domains/publishing'
import { listRepos } from '../../host/github-repos'
import { manifestEntries } from '../../host/nix-manifest'
import { imageInfo } from '../../host/registry'
import { swrCache } from '../cache'
import type { RepoBuild } from '../readiness'
import { createApp, getApp, listAppNames } from '../repo/apps'
import { appRepo, defaultImage } from '../site'
import { gatedReference } from './image-gate'
import { registerAwaiting } from './setup'
import { validateNewApp } from './validate'

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
  const [repos, names, manifest, publishing] = await Promise.all([
    listRepos(),
    listAppNames(),
    manifestEntries(),
    publishingFacts(),
  ])

  // A name is taken if EITHER source knows it: the database holds what
  // daedalus manages, the manifest additionally holds the hand-written
  // entries. The picker greys those repos out rather than letting the create
  // fail at the last step.
  const taken = [...new Set([...names, ...manifest.map((m) => m.name)])]

  // The labels no app may take: the name derives the hostname.
  return { taken, reservedLabels: publishing.reservedLabels, ...repos }
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
 * one.
 */
async function repoBuild(ctx: Ctx, name: string): Promise<RepoBuild> {
  return REPO_BUILD.get(name, async () => {
    // `<owner>/<app name>` — the same assumption the build service, the detail
    // page and the default image all make: an app is its repository's name.
    const fullName = appRepo(ctx.site, name)
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
 * Neither is a gate; lib/readiness.ts says why.
 */
export async function appPreflight(ctx: Ctx, data: { name: string; image: string | null }) {
  const site = ctx.site
  const effectiveImage = data.image?.trim() || defaultImage(site, data.name)

  // Only images on the box's own zot can be verified from here — an override
  // pointing at GHCR or docker.io is reported as unverified rather than
  // guessed at, because a wrong "missing" would block a legitimate fork.
  const local = gatedReference(site, {
    name: data.name,
    image: data.image,
    sourceMode: 'registry',
    managedInNix: false,
  })
  // Two independent upstreams — the box's own zot and GitHub — so they are
  // asked together rather than one behind the other.
  const [imageState, build] = await Promise.all([
    local === null
      ? Promise.resolve('unverifiable' as const)
      : imageInfo(local.repo, local.reference).then((info) =>
          info.digest === null ? ('missing' as const) : ('present' as const),
        ),
    repoBuild(ctx, data.name),
  ])

  return { effectiveImage, imageState, repoBuild: build }
}

/**
 * Create the entry, link it to its GitHub repository, register it and queue
 * its first build — no rebuild (./setup.ts has the whole path). The entry
 * stands whatever happens after: a link, a register or a build that did not
 * start is reported beside it, the app's page offers Retry, and the next
 * scheduler tick registers what is not registered yet.
 */
export async function createAppLinked(
  ctx: Ctx,
  input: Record<string, unknown>,
  actor: string,
): Promise<{ name: string; link: RepoLink }> {
  const { name } = await createApp(validateNewApp(input))
  const record = await getApp(name)
  const link: RepoLink =
    record === undefined
      ? { ok: false, reason: `${name} was created, but could not be read back to link it.` }
      : await linkAppRepo(ctx, record)
  const registered = await registerAwaiting(ctx, actor)
  if (!registered.ok) console.warn(`[setup] ${name}: not registered yet: ${registered.reason}`)
  if (link.ok && record?.buildOnBox) {
    // Queued now; it waits in the queue until the register has committed the
    // entry the builder authorizes it from (core/builds/dispatch.ts).
    const built = await buildNow({ app: name, actor })
    if (!built.ok) console.warn(`[setup] ${name}: first build not queued: ${built.reason}`)
  }
  return { name, link }
}
