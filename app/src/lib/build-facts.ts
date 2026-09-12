// What the box made, and how it made it: the two optional status keys the host
// build agent publishes once BuildKit has run. Pure and client-safe, like
// build-detect.ts, and decoded the same tolerant way — the agent ships with a
// NixOS rebuild and this container with a git push, so a key that arrives
// renamed must blank one row, never the page.
//
// The contract, as the agent writes it:
//
//   image  { tags, layers, layerSizes, configSize, mediaType }
//          Read back off the manifest zot serves, so `tags` is what was
//          actually pushed rather than what the publish mode predicts, and the
//          sizes are the COMPRESSED bytes the manifest lists — a pull, not a
//          disk footprint.
//   build  { runner, secretsHash, cacheImported, cacheExported, stepsCached,
//          stepsTotal }
//          How the build itself went: which builder ran it, a fingerprint of
//          the build secrets (never a value), and what the cache did.
//
// Held on the row as one `facts` jsonb rather than five columns: none of it is
// queried, compared or indexed — it is read back whole, for one page and one
// check run — and the agent grows keys faster than a migration per key would be
// worth. `digest` and `size_bytes` stay their own columns, because those two
// ARE matched against deploy rows and summed.

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const flag = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const counts = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : []
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []

export type ImageFacts = {
  /** The tags the push actually left on the registry. */
  tags: string[]
  layers: number | null
  /** Compressed layer sizes, in manifest order — what a pull moves. */
  layerSizes: number[]
  configSize: number | null
  mediaType: string | null
}

/** The wire calls this `build`; on the row it is `run`, so nothing reads `facts.build.build`. */
export type RunFacts = {
  runner: string | null
  /** A fingerprint of the build secrets. A hash, never a value. */
  secretsHash: string | null
  cacheImported: boolean | null
  cacheExported: boolean | null
  stepsCached: number | null
  stepsTotal: number | null
}

export type BuildFacts = { image: ImageFacts | null; run: RunFacts | null }

function readImage(raw: unknown): ImageFacts | null {
  if (!isRec(raw)) return null
  return {
    tags: strings(raw.tags),
    layers: count(raw.layers),
    layerSizes: counts(raw.layerSizes),
    configSize: count(raw.configSize),
    mediaType: text(raw.mediaType),
  }
}

function readRun(raw: unknown): RunFacts | null {
  if (!isRec(raw)) return null
  return {
    runner: text(raw.runner),
    secretsHash: text(raw.secretsHash),
    cacheImported: flag(raw.cacheImported),
    cacheExported: flag(raw.cacheExported),
    stepsCached: count(raw.stepsCached),
    stepsTotal: count(raw.stepsTotal),
  }
}

/**
 * The status's `image` and `build` keys as one value, or null when an agent
 * published neither — which is every build before this contract existed, and
 * every build that failed before an image. Null is the signal not to write the
 * column at all, so an old row keeps reading as "nobody said".
 */
export function readBuildFacts(status: { image?: unknown; build?: unknown }): BuildFacts | null {
  const image = readImage(status.image)
  const run = readRun(status.build)
  return image === null && run === null ? null : { image, run }
}

/**
 * `size_bytes` restated from the parts, for the label beside it: the manifest's
 * config plus its compressed layers is the number of bytes a `podman pull`
 * moves, which is not the space the image takes once unpacked. Null unless the
 * agent listed every part.
 */
export function pullBytes(image: ImageFacts | null): number | null {
  if (image === null || image.configSize === null || image.layerSizes.length === 0) return null
  return image.layerSizes.reduce((sum, n) => sum + n, image.configSize)
}

/** Steps the cache answered for, as a share — null unless the agent counted both. */
export function cacheHitRatio(run: RunFacts | null): number | null {
  if (run === null || run.stepsTotal === null || run.stepsTotal <= 0 || run.stepsCached === null) {
    return null
  }
  return run.stepsCached / run.stepsTotal
}
