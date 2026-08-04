// Reads image metadata straight out of zot.
//
// Anonymous: the registry's accessControl gives anonymous pull-only, which is
// exactly what this needs — no credential to hold, and nothing here can write.
// Reached over traefik (https://registry.toscanini.me) because daedalus is
// `isolated` and deliberately not on registry-net, where the CI runners live.

const REGISTRY = () => process.env.REGISTRY_URL ?? 'https://registry.toscanini.me'

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.index.v1+json',
].join(', ')

export type ImageInfo = {
  digest: string | null
  revision: string | null
  sourceUrl: string | null
  createdAt: Date | null
}

const EMPTY: ImageInfo = { digest: null, revision: null, sourceUrl: null, createdAt: null }

/**
 * OCI labels for a repo reference (a tag or a digest).
 *
 * Best-effort by design: an old manifest may already have been garbage
 * collected, and the whole registry may be down. Deploy history must render
 * either way, so every failure path returns nulls rather than throwing.
 */
export async function imageInfo(repo: string, reference: string): Promise<ImageInfo> {
  try {
    const manifestRes = await fetch(`${REGISTRY()}/v2/${repo}/manifests/${reference}`, {
      headers: { Accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(8_000),
    })
    if (!manifestRes.ok) return EMPTY

    const digest = manifestRes.headers.get('docker-content-digest')
    const manifest = (await manifestRes.json()) as { config?: { digest?: string } }

    const configDigest = manifest.config?.digest
    if (!configDigest) return { ...EMPTY, digest }

    const configRes = await fetch(`${REGISTRY()}/v2/${repo}/blobs/${configDigest}`, {
      signal: AbortSignal.timeout(8_000),
    })
    if (!configRes.ok) return { ...EMPTY, digest }

    const config = (await configRes.json()) as {
      created?: string
      config?: { Labels?: Record<string, string> }
    }
    const labels = config.config?.Labels ?? {}

    return {
      digest,
      revision: labels['org.opencontainers.image.revision'] ?? null,
      sourceUrl: labels['org.opencontainers.image.source'] ?? null,
      createdAt: config.created ? new Date(config.created) : null,
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
