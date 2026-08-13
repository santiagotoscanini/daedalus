import { join } from 'node:path'
import { arrayOf, bool, nullable, obj, optional, recordOf, str } from '../decode'
import { readSnapshot } from '../snapshot'

// /export/images.json — every container's image, from the two ends the flake
// knows about.
//
// `tags` is what tag each container carries, WHATEVER shape it is
// (`10.11.11ubu2404-ls42`, `jvm-stable`, `latest`, `8`). Deciding whether a
// tag names a version is the reader's job; see lib/dashboard/images.ts for the
// pin-vs-label ordering argument.
//
// `pins` is the same containers seen from the other end: not the tag but the
// ref that tag was frozen from, and whether this app may move it. It exists
// because the Updates page has to render EVERY digest-pinned container —
// including the two dozen sidecars and exporters that have no page of their
// own — and a page cannot enumerate what nothing publishes.
//
// Schema 2 added `pins`. Read tolerantly rather than gated at 2, because the
// two halves fail independently: a box that has not re-published since the
// upgrade still has correct `tags`, and blanking every version on the dash to
// insist on a field only one page needs is the wrong trade.

const pinShape = obj({
  /** `<repo>:<tag>`, the ref the registry is asked about. */
  image: str,
  /** The repository alone, without the tag. */
  repo: str,
  tag: str,
  /** `sha256:…` — the one part of a pin that is always literal in the source. */
  digest: str,
  /** False when moving this pin is not a pin edit (see fleet.imageUpdates). */
  updatable: optional(bool, true),
  /** Containers that must move in the same commit as this one. */
  lockstep: optional(arrayOf(str), []),
  /** What else this update takes down, in one clause. Null = only itself. */
  ceremony: optional(nullable(str), null),
})

export type ImagePin = ReturnType<typeof pinShape>

const shape = obj({
  tags: optional(recordOf(str), {}),
  pins: optional(recordOf(pinShape), {}),
})

async function domain(): Promise<{ tags: Record<string, string>; pins: Record<string, ImagePin> }> {
  const r = await readSnapshot({
    path: join(process.env.EXPORT_DIR ?? '/export', 'images.json'),
    decoder: shape,
    fallback: { tags: {}, pins: {} },
    acceptVersions: [1, 2],
  })
  return r.data
}

export async function imageTagMap(): Promise<Record<string, string>> {
  return (await domain()).tags
}

/**
 * Container → its digest pin and the policy for moving it.
 *
 * Empty for every container that has no `:tag@sha256:` pin at all — a locally
 * built image (mkLocalImage) or an app on the registry deploy loop. Neither is
 * updated by editing a pin, so their absence here is the correct answer rather
 * than missing data.
 */
export async function imagePins(): Promise<Record<string, ImagePin>> {
  return (await domain()).pins
}
