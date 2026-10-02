import type { Ctx } from '../../core/ctx'
import { imagePresence } from '../../host/registry'
import { defaultImage, registryHostPattern, type Site } from '../site'
import { stageRuns } from '../stage'

// The first-image gate: a rung that runs a container (off, lab, live) is only
// offered, saved and applied once the image that container pulls exists.
// Without it an Apply declares a container that cannot pull, the switch fails
// (exit 125), and the rollback restarts the resolver the whole house uses.
//
// Asked of the box's own registry, at the exact reference the container pulls
// (`latest` unless the image names another): a `sha-*` tag beside a missing
// `latest` would not help that pull. An image override that points at the
// box's registry is checked the same way; one that points anywhere else is the
// operator's to vouch for and is not checked (`unchecked`).
//
// Only the step INTO running is gated (declared, or new to the box, to any
// running rung). An app already running has pulled its image, and a registry
// that does not answer must not stop it from changing exposure.

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

/** Whether the step from `from` (null: not on the box yet) to `to` needs the image to exist. */
export const needsFirstImage = (from: string | null, to: string): boolean =>
  stageRuns(to) && (from === null || !stageRuns(from))

export async function firstImage(site: Site, app: GateApp): Promise<FirstImage> {
  const ref = gatedReference(site, app)
  return ref === null ? 'unchecked' : imagePresence(ref.repo, ref.reference)
}

/** Why the app cannot run yet, in words a page can show; null when it can. */
export function imageRefusal(name: string, state: FirstImage): string | null {
  switch (state) {
    case 'missing':
      return `${name} has no image in the box's registry yet. Build it first; it can run once the first build has published.`
    case 'unknown':
      return `The box's registry did not answer, so it is not known whether ${name} has an image yet. Try again once it answers.`
    default:
      return null
  }
}

/** The save's check: why `name` may not move to `stage` now, or null. */
export async function stageChangeRefusal(
  ctx: Pick<Ctx, 'site'>,
  name: string,
  stage: string,
): Promise<string | null> {
  const { getApp } = await import('../repo/apps')
  const record = await getApp(name)
  if (!record || !needsFirstImage(record.stage, stage)) return null
  return imageRefusal(name, await firstImage(ctx.site, record))
}

/**
 * The Apply's check, over every app whose stage would step into running
 * against what the box last applied. One sentence per app that would fail
 * the switch; empty when none would.
 */
export async function applyImageBlockers(
  site: Site,
  records: readonly (GateApp & { stage: string })[],
  applied: ReadonlyMap<string, { stage: string }>,
): Promise<string[]> {
  const gated = records.filter(
    (r) => !r.managedInNix && needsFirstImage(applied.get(r.name)?.stage ?? null, r.stage),
  )
  const reasons = await Promise.all(
    gated.map(async (r) => imageRefusal(r.name, await firstImage(site, r))),
  )
  return reasons.filter((r): r is string => r !== null)
}
