import { imagePresence } from '../../host/registry'
import { defaultImage, registryHostPattern, type Site } from '../site'

// Whether an app's first image exists: what clears a new app's
// `awaitingImage` (./setup.ts) and what the create form reports.
//
// Asked of the box's own registry, at the exact reference the container pulls
// (`latest` unless the image names another): a `sha-*` tag beside a missing
// `latest` would not help that pull. An image override that points at the
// box's registry is checked the same way; one that points anywhere else is the
// operator's to vouch for and is not checked (`unchecked`).

export type FirstImage = 'present' | 'missing' | 'unknown' | 'unchecked'

type GateApp = { name: string; image: string | null; sourceMode: string; managedInNix: boolean }

/** The box-registry reference the app's container pulls; null when it is not one the box can check. */
export function gatedReference(
  site: Site,
  app: GateApp,
): { image: string; repo: string; reference: string } | null {
  if (app.managedInNix || app.sourceMode !== 'registry') return null
  const image = app.image?.trim() || defaultImage(site, app.name)
  const m = new RegExp(`^${registryHostPattern(site)}/(?<repo>[^:@]+)(?<ref>[:@].+)?$`).exec(image)
  const repo = m?.groups?.repo
  if (repo === undefined) return null
  // `:tag` or `@digest`; the separator is dropped, since the manifest
  // endpoint takes either as a bare reference.
  return { image, repo, reference: (m?.groups?.ref ?? ':latest').slice(1) }
}

export async function firstImage(site: Site, app: GateApp): Promise<FirstImage> {
  const ref = gatedReference(site, app)
  return ref === null ? 'unchecked' : imagePresence(ref.repo, ref.reference)
}
