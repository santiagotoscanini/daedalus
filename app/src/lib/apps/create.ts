import { listRepos } from '../../host/github-repos'
import { manifestEntries } from '../../host/nix-manifest'
import { imageInfo } from '../../host/registry'
import { listApps } from '../repo/apps'
import { defaultImage, REGISTRY_HOST_PATTERN } from '../site'

// The two reads behind the create form: what it can be pointed at, and
// whether the image it would produce actually exists.

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
 * The one thing that has to be true before a repo can become an app: an image
 * the box can actually pull.
 *
 * It is a hard gate. A declaration whose image does not exist produces a
 * container that cannot start, on a timer, until somebody notices — and the
 * failing container fails the switch, which makes the Apply revert itself.
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
  const imageState =
    local?.groups?.repo === undefined
      ? ('unverifiable' as const)
      : await imageInfo(local.groups.repo, (local.groups.ref ?? ':latest').slice(1)).then((info) =>
          info.digest === null ? ('missing' as const) : ('present' as const),
        )

  return { effectiveImage, imageState }
}
