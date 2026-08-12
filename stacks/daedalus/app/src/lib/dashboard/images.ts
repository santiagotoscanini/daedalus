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

import { swrValue } from '../cache'
import { bool, nullable, obj, optional, recordOf, str } from '../contract/decode'
import { imageTagMap } from '../contract/domains/images'
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

// A snapshot that has gone missing is a reason to serve the last good one
// (lib/cache.ts), not to report every service as unknown.
const cached = swrValue({ ttlMs: TTL_MS, retryMs: TTL_MS }, async () => {
  const result = await readSnapshot({
    path: process.env.IMAGE_LABELS_PATH ?? '/images/labels.json',
    decoder: labelsShape,
    fallback: {},
  })
  return result.available ? result.data : null
})

async function snapshot(): Promise<Record<string, ImageLabels>> {
  return (await cached()) ?? {}
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
export async function imageTag(container: string): Promise<string | null> {
  return asVersion((await imageTagMap())[container])
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
  const [pinned, labels] = await Promise.all([imageTag(container), imageLabels(container)])
  const shortRevision = labels.revision === null ? null : labels.revision.slice(0, 7)

  if (pinned !== null) return { version: pinned, source: 'pin', revision: shortRevision }

  const labelled = asVersion(labels.version)
  if (labelled !== null) return { version: labelled, source: 'label', revision: shortRevision }

  return { version: null, source: 'unknown', revision: shortRevision }
}

// ── the registry ──────────────────────────────────────────────────────────
//
// The third source, answering the one question the other two cannot: a pin
// like `:latest@sha256:…` freezes an image forever, and neither the tag (a
// channel name) nor the label (a fact about the FROZEN artefact) can say
// whether the channel has since moved on. Only the registry knows, so a daily
// host oneshot (daedalus-image-freshness) asks it and publishes the answer
// beside labels.json.

/** What the registry said about one container's pin, from the daily probe. */
export type ImageFreshness = {
  /** The tag ref the pin was taken from, e.g. `ghcr.io/schaka/janitorr:jvm-stable`. */
  image: string
  tag: string
  pinnedDigest: string
  /** Where the tag points now. Null when the registry did not answer. */
  remoteDigest: string | null
  /** The tag no longer points at the pinned digest. */
  moved: boolean
  /** When the image the tag NOW points at was built. Fetched only when moved. */
  remoteCreated: string | null
  checkedAt: string
  /** The registry's refusal, verbatim-ish. Non-null means `moved` says nothing. */
  error: string | null
}

const freshnessShape = recordOf(
  obj({
    image: str,
    tag: str,
    pinnedDigest: str,
    remoteDigest: nullable(str),
    moved: bool,
    remoteCreated: nullable(str),
    checkedAt: str,
    error: nullable(str),
  }),
)

// Three days: the producing timer is daily, and the shared convention (see
// contract/snapshot.ts) is that one missed run is jitter and three is a
// stopped producer. A stale file is treated as absent rather than served —
// "the tag moved" asserted by a probe that died last week is exactly the
// confidently-wrong answer this dashboard exists to avoid.
const FRESHNESS_MAX_AGE_MS = 3 * 86_400_000

const cachedFreshness = swrValue({ ttlMs: TTL_MS, retryMs: TTL_MS }, async () => {
  const result = await readSnapshot({
    path: process.env.IMAGE_FRESHNESS_PATH ?? '/images/freshness.json',
    decoder: freshnessShape,
    fallback: {},
    acceptVersions: [1],
    maxAgeMs: FRESHNESS_MAX_AGE_MS,
  })
  return result.available && !result.stale ? result.data : null
})

/**
 * Whether a container's digest pin is still what its tag points at.
 *
 * Null when there is nothing to say: the container is not digest-pinned to a
 * tag, the probe has never run, or its file has gone stale. Callers render
 * null as no verdict at all — absence of evidence, stated as absence.
 */
export async function imageFreshness(container: string): Promise<ImageFreshness | null> {
  return (await cachedFreshness())?.[container] ?? null
}
