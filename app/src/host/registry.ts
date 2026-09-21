// Reads image metadata straight out of zot.
//
// Anonymous: the registry's accessControl gives anonymous pull-only, which is
// exactly what this needs — no credential to hold, and nothing here can write.
// Reached over traefik (https://registry.toscanini.me) because daedalus is
// `isolated` and deliberately not on registry-net, where the registry lives.

import { env } from './env'
import { readSite } from './site'

const REGISTRY = () => env.get('REGISTRY_URL') ?? `https://${readSite().registryHost}`

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ')

const REVISION = 'org.opencontainers.image.revision'
const SOURCE = 'org.opencontainers.image.source'

type Annotations = Record<string, string> | null | undefined

type Descriptor = {
  digest?: string
  platform?: { os?: string; architecture?: string }
  annotations?: Record<string, string>
}

/** An image manifest or an index, whichever the reference names. */
type Manifest = {
  config?: { digest?: string }
  manifests?: Descriptor[]
  annotations?: Record<string, string>
}

type ImageConfig = {
  created?: string
  config?: { Labels?: Record<string, string> | null }
}

export type ImageInfo = {
  digest: string | null
  revision: string | null
  sourceUrl: string | null
  createdAt: Date | null
}

const EMPTY: ImageInfo = { digest: null, revision: null, sourceUrl: null, createdAt: null }

/**
 * A digest as it may appear in a registry URL. Anything the registry's JSON
 * names is checked against this first: a digest is a path segment, and
 * `../` in one would address another endpoint.
 */
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

const isDigest = (v: unknown): v is string => typeof v === 'string' && DIGEST_RE.test(v)

/** This machine's architecture, in OCI's words rather than Node's. */
const ARCH = process.arch === 'x64' ? 'amd64' : process.arch

/**
 * The runnable image an index points at: this machine's platform, else the
 * first real image. BuildKit lists attestation manifests beside the image as
 * `unknown/unknown`, and those have no config worth reading.
 */
function platformEntry(index: Manifest): Descriptor | null {
  const images = (index.manifests ?? []).filter(
    (d) =>
      isDigest(d.digest) &&
      d.platform?.os !== 'unknown' &&
      d.annotations?.['vnd.docker.reference.type'] !== 'attestation-manifest',
  )
  return (
    images.find((d) => d.platform?.os === 'linux' && d.platform.architecture === ARCH) ??
    images[0] ??
    null
  )
}

/**
 * An OCI repository path: lowercase segments joined by single slashes.
 *
 * `repo` arrives from an app's `image` field, which an operator types, so it is
 * the one part of the URL below that is not ours. Interpolated raw, `../..`
 * climbed out of `/v2/<repo>/` onto a different endpoint of the box's own
 * registry. Encoding does not fix that — `encodeURIComponent('..')` is `'..'`
 * — but refusing the segment does.
 *
 * Permissive about everything else on purpose: a namespace with slashes is
 * ordinary, and `image` exists precisely so an app can point somewhere else.
 */
const REPO_PATH = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/

function pull(repo: string, path: string, accept?: string): Promise<Response> {
  // `path` is ours — a tag, a digest, `manifests/<ref>`. `repo` is not.
  if (!REPO_PATH.test(repo)) {
    return Promise.reject(new Error(`not a repository path: ${repo}`))
  }
  return fetch(`${REGISTRY()}/v2/${repo}/${path}`, {
    ...(accept === undefined ? {} : { headers: { Accept: accept } }),
    signal: AbortSignal.timeout(8_000),
  })
}

/** The first non-empty value of `key`, searching the sets in order. */
function pick(key: string, sets: Annotations[]): string | null {
  for (const set of sets) {
    const v = set?.[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

/**
 * OCI labels for a repo reference (a tag or a digest).
 *
 * Best-effort by design: an old manifest may already have been garbage
 * collected, and the whole registry may be down. Deploy history must render
 * either way, so every failure path returns nulls rather than throwing.
 */
export async function imageInfo(repo: string, reference: string): Promise<ImageInfo> {
  try {
    const manifestRes = await pull(repo, `manifests/${reference}`, MANIFEST_ACCEPT)
    if (!manifestRes.ok) return EMPTY

    // The digest the reference resolved to, which is the index's for a
    // multi-platform push: that is what a deploy pins.
    const digest = manifestRes.headers.get('docker-content-digest')
    const top = (await manifestRes.json()) as Manifest

    // Where a revision may be written, nearest the image first: the config's
    // labels (a Dockerfile's LABEL), then annotations. Railpack writes the
    // revision only as a manifest annotation. In an index, that means the
    // platform manifest's, then its entry in the index, then the index's own.
    let manifest: Manifest | null = top
    let annotations: Annotations[] = [top.annotations]
    if (Array.isArray(top.manifests)) {
      const entry = platformEntry(top)
      const target = entry?.digest
      const inner =
        target === undefined ? null : await pull(repo, `manifests/${target}`, MANIFEST_ACCEPT)
      manifest = inner?.ok ? ((await inner.json()) as Manifest) : null
      annotations = [manifest?.annotations, entry?.annotations, top.annotations]
    }

    const configDigest = manifest?.config?.digest
    const configRes = isDigest(configDigest) ? await pull(repo, `blobs/${configDigest}`) : null
    const config = configRes?.ok ? ((await configRes.json()) as ImageConfig) : null
    const sets = [config?.config?.Labels, ...annotations]

    return {
      digest,
      revision: pick(REVISION, sets),
      sourceUrl: pick(SOURCE, sets),
      createdAt: config?.created ? new Date(config.created) : null,
    }
  } catch {
    return EMPTY
  }
}

/** github.com/owner/repo + sha → a commit URL, when both are known. */
export function commitUrl(sourceUrl: string | null, revision: string | null): string | null {
  if (!sourceUrl || !revision) return null
  return `${sourceUrl.replace(/\.git$/, '').replace(/\/$/, '')}/commit/${revision}`
}
