// What version a container is actually running.
//
// Two sources, and the order between them is the whole content of this file.
//
// ── the pin ───────────────────────────────────────────────────────────────
//
// `IMAGE_TAGS` is every container's image tag as the flake wrote it. It is the
// best answer whenever it carries a version, because it is what this box ASKED
// for: it is in git, it is what a rebuild would reproduce, and it is what a
// bump would change.
//
// It is silent for a pin that names a channel rather than a release —
// `:latest`, `jvm-stable`, a bare major. Five containers here are in that
// state, and until this file existed the dashboard reported them as unknown,
// or read a version back out of a startup banner in Loki, which only works
// while the container has restarted inside Loki's retention window.
//
// ── the label ─────────────────────────────────────────────────────────────
//
// `org.opencontainers.image.version` is a standard OCI annotation and most
// publishers set it. It is a fact about the artefact on disk, so it needs no
// network, no API on the service and no log retention — which makes it exactly
// the right fallback.
//
// It is a FALLBACK and not the primary on purpose. Some images inherit the
// annotation from their base and report something unrelated: Cleanuparr's says
// `24.04`, which is Ubuntu's, while its tag correctly says 2.10.1. A
// label-first rule would have made that service confidently wrong, which is
// worse than the blank it replaced.
//
// Published by daedalus-image-snapshot (stacks/daedalus/host/image-snapshot.sh)
// because this app cannot run podman — it is a container itself.

import { nullable, obj, optional, recordOf, str } from '../contract/decode'
import { readEnvJson } from '../contract/env'
import { readSnapshot } from '../contract/snapshot'

export type ImageLabels = {
  /** `org.opencontainers.image.version`. */
  version: string | null
  /** The source commit the image was built from. */
  revision: string | null
  /** The project's repository URL. */
  source: string | null
  /** When the image was built, ISO-8601. */
  created: string | null
}

const EMPTY: ImageLabels = { version: null, revision: null, source: null, created: null }

const ns = optional(nullable(str), null)
const labelsShape = recordOf(obj({ version: ns, revision: ns, source: ns, created: ns }))

/**
 * The snapshot, read at most once per `TTL_MS`.
 *
 * A file read is cheap, but this is called several times per render and the
 * content changes only when an image does — which is a rebuild or a deploy
 * pull, both minutes apart at best. Failure keeps the previous answer rather
 * than blanking every version on the page: an absent snapshot means the
 * oneshot has not run yet, not that nothing has a version.
 */
const TTL_MS = 60_000
let cache: { at: number; labels: Record<string, ImageLabels> } | null = null

async function snapshot(): Promise<Record<string, ImageLabels>> {
  const now = Date.now()
  if (cache !== null && now - cache.at < TTL_MS) return cache.labels

  const result = await readSnapshot({
    path: process.env.IMAGE_LABELS_PATH ?? '/images/labels.json',
    decoder: labelsShape,
    fallback: {},
  })

  if (!result.available) {
    // Keep whatever we had. A snapshot that has gone missing is a reason to
    // serve the last good one, not to report every service as unknown.
    if (cache !== null) return cache.labels
    cache = { at: now, labels: {} }
    return {}
  }

  cache = { at: now, labels: result.data }
  return result.data
}

/** Everything the image says about itself. */
export async function imageLabels(container: string): Promise<ImageLabels> {
  return (await snapshot())[container] ?? EMPTY
}

/**
 * A version string, or null if this is not one.
 *
 * Two numeric segments minimum. That is what separates a version from the
 * channel names that turn up in both sources — `latest`, `main`, `jvm-stable`,
 * and the bare `8` Recyclarr is pinned to. A leading `v` is stripped; a
 * trailing build suffix is kept off, so linuxserver's `4.0.19.2979-ls320`
 * becomes the upstream `4.0.19.2979` it actually contains.
 */
function asVersion(raw: string | null | undefined): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  return /^v?(\d+\.\d+(?:\.\d+)*)/.exec(raw)?.[1] ?? null
}

/**
 * The tag a container is pinned to, from the flake. Null for a moving tag.
 *
 * `IMAGE_TAGS` is written by nix over every oci container, so a page that
 * wants to report a version costs no nix edit — see the binding in
 * stacks/daedalus/daedalus.nix.
 */
export function imageTag(container: string): string | null {
  const tags = readEnvJson('IMAGE_TAGS', recordOf(str), {})
  return asVersion(tags[container])
}

/**
 * What a container is running, and how confidently we know it.
 *
 * `source` is not decoration — it is the difference between a number the page
 * can stand behind and one it inferred, and the panels say which. A version
 * from the pin is reproducible from git; a version from a label is a claim the
 * publisher made about an artefact that a re-pull could silently replace.
 */
export type RunningVersion = {
  version: string | null
  source: 'pin' | 'label' | 'unknown'
  /** The commit the image was built from, when the publisher recorded one. */
  revision: string | null
}

export async function imageVersion(container: string): Promise<RunningVersion> {
  const pinned = imageTag(container)
  const labels = await imageLabels(container)
  const shortRevision = labels.revision === null ? null : labels.revision.slice(0, 7)

  if (pinned !== null) return { version: pinned, source: 'pin', revision: shortRevision }

  const labelled = asVersion(labels.version)
  if (labelled !== null) return { version: labelled, source: 'label', revision: shortRevision }

  return { version: null, source: 'unknown', revision: shortRevision }
}
