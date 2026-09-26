import { join } from 'node:path'
import {
  arrayOf,
  bool,
  literal,
  nullable,
  obj,
  optional,
  recordOf,
  str,
} from '../../../lib/contract/decode'
import { env } from '../../env'
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
// including the sidecars and exporters that have no page of their own — and
// a page cannot enumerate what nothing publishes.
//
// `manual` is everything else the box runs on a pin (fleet.manualPins in
// nix/platform/export.nix): the bases of the images built on the box, the
// build tools' images, a source commit. Each names the file a bump edits; a
// base pinned in the configuration is also `updatable` — the Update button
// moves it through the same agent, under the pin's id.

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
  /** `ceremony`, but only for a move to a new major (lib/image-ceremony.ts). */
  majorCeremony: optional(nullable(str), null),
})

export type ImagePin = ReturnType<typeof pinShape>

const pinnedInShape = obj({
  /** Which repository holds the literal: the engine, or this box's configuration. */
  repo: literal('engine', 'config'),
  /** Relative to that repository's root. */
  path: str,
})

export type PinnedIn = ReturnType<typeof pinnedInShape>

const manualShape = obj({
  /** `<repo>:<tag>` when the pin is an image; null for a commit or a release number. */
  image: nullable(str),
  repo: nullable(str),
  tag: nullable(str),
  digest: nullable(str),
  /** What runs: the tag, a release, or — with `branch` — a commit. */
  version: str,
  /** GitHub `owner/repo` for the notes; null = what the first container reads. */
  upstream: optional(nullable(str), null),
  /** Compare `version` as a commit on this branch. */
  branch: optional(nullable(str), null),
  /** Versions that move with this one, as a set. */
  parts: optional(recordOf(str), {}),
  containers: optional(arrayOf(str), []),
  note: optional(nullable(str), null),
  pinnedIn: pinnedInShape,
  /** A configuration base the Update button moves. An engine that predates it: false. */
  updatable: optional(bool, false),
  ceremony: optional(nullable(str), null),
  majorCeremony: optional(nullable(str), null),
})

export type ManualPin = ReturnType<typeof manualShape>

const shape = obj({
  tags: optional(recordOf(str), {}),
  pins: optional(recordOf(pinShape), {}),
  // Optional: a box whose engine predates it publishes none.
  manual: optional(recordOf(manualShape), {}),
})

type Images = {
  tags: Record<string, string>
  pins: Record<string, ImagePin>
  manual: Record<string, ManualPin>
}

async function domain(): Promise<Images> {
  const r = await readSnapshot({
    path: join(env.get('EXPORT_DIR'), 'images.json'),
    decoder: shape,
    fallback: { tags: {}, pins: {}, manual: {} },
    acceptVersions: [2],
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
 * than missing data. A local image's BASE is in `manualPins` instead.
 */
export async function imagePins(): Promise<Record<string, ImagePin>> {
  return (await domain()).pins
}

/** Pin id → a pin moved by an ordinary commit, and where that commit edits. */
export async function manualPins(): Promise<Record<string, ManualPin>> {
  return (await domain()).manual
}
