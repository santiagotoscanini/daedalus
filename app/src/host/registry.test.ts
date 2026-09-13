import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { imageInfo } from './registry'

// imageInfo against a fake zot: the manifest and config shapes the builders
// on this box actually push. A Dockerfile build (docker buildx) labels the
// config and annotates the manifest. A Railpack build only annotates. A
// multi-platform or attested push names an index, whose attestation entry must
// never be mistaken for the image.

const REG = 'http://zot.test'
const REVISION = 'org.opencontainers.image.revision'
const SOURCE = 'org.opencontainers.image.source'
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json'
const ARCH = process.arch === 'x64' ? 'amd64' : process.arch

const digest = (c: string) => `sha256:${c.repeat(64)}`
const CFG = digest('c')
const IMAGE = digest('1')
const ATTESTATION = digest('a')

type Route = { body: unknown; digest?: string } | number

function serve(routes: Record<string, Route>): string[] {
  const seen: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const path = String(input).slice(REG.length)
      seen.push(path)
      const route = routes[path] ?? 404
      if (typeof route === 'number') return new Response('{}', { status: route })
      return new Response(JSON.stringify(route.body), {
        status: 200,
        headers: route.digest === undefined ? {} : { 'docker-content-digest': route.digest },
      })
    }),
  )
  return seen
}

const manifest = (annotations?: Record<string, string>, config = CFG) => ({
  schemaVersion: 2,
  mediaType: OCI_MANIFEST,
  config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: config, size: 1 },
  layers: [],
  ...(annotations === undefined ? {} : { annotations }),
})

/** Railpack's config: a creation time, and no Labels at all. */
const railpackConfig = {
  created: '2026-09-10T12:00:00Z',
  architecture: ARCH,
  os: 'linux',
  config: { Env: ['PATH=/usr/local/bin:/usr/bin'], Cmd: ['node', 'server.js'] },
}

beforeEach(() => {
  vi.stubEnv('REGISTRY_URL', REG)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('imageInfo', () => {
  it('reads the revision and source from manifest annotations when the config has no labels', async () => {
    serve({
      '/v2/app/manifests/latest': {
        digest: 'sha256:top',
        body: manifest({ [REVISION]: 'abc123', [SOURCE]: 'https://github.com/o/app' }),
      },
      [`/v2/app/blobs/${CFG}`]: { body: railpackConfig },
    })
    expect(await imageInfo('app', 'latest')).toEqual({
      digest: 'sha256:top',
      revision: 'abc123',
      sourceUrl: 'https://github.com/o/app',
      createdAt: new Date('2026-09-10T12:00:00Z'),
    })
  })

  it('prefers a config label over the annotation', async () => {
    serve({
      '/v2/app/manifests/latest': {
        digest: 'sha256:top',
        body: manifest({ [REVISION]: 'from-annotation', [SOURCE]: 'https://github.com/o/app' }),
      },
      [`/v2/app/blobs/${CFG}`]: {
        body: { ...railpackConfig, config: { Labels: { [REVISION]: 'from-label', [SOURCE]: '' } } },
      },
    })
    const info = await imageInfo('app', 'latest')
    expect(info.revision).toBe('from-label')
    // An empty label is no label.
    expect(info.sourceUrl).toBe('https://github.com/o/app')
  })

  it('still reads the annotation when the config blob is gone', async () => {
    serve({
      '/v2/app/manifests/latest': {
        digest: 'sha256:top',
        body: manifest({ [REVISION]: 'abc123' }),
      },
      [`/v2/app/blobs/${CFG}`]: 500,
    })
    expect(await imageInfo('app', 'latest')).toEqual({
      digest: 'sha256:top',
      revision: 'abc123',
      sourceUrl: null,
      createdAt: null,
    })
  })

  it.each([
    ['a path', '../../other/manifests/latest'],
    ['a short digest', 'sha256:cfg'],
    ['an uppercase digest', digest('C')],
    ['another algorithm', `sha512:${'c'.repeat(128)}`],
    ['a digest with a suffix', `${CFG}/../x`],
    ['a number', 42],
  ])('never puts a config digest that is %s into a URL', async (_label, bad) => {
    const seen = serve({
      '/v2/app/manifests/latest': {
        digest: 'sha256:top',
        body: { ...manifest({ [REVISION]: 'abc123' }), config: { digest: bad } },
      },
    })
    expect((await imageInfo('app', 'latest')).revision).toBe('abc123')
    expect(seen).toEqual(['/v2/app/manifests/latest'])
  })

  describe('an index', () => {
    const index = (annotations: Record<string, string>, entries?: unknown[]) => ({
      schemaVersion: 2,
      mediaType: OCI_INDEX,
      manifests: entries ?? [
        {
          mediaType: OCI_MANIFEST,
          digest: ATTESTATION,
          size: 1,
          platform: { architecture: 'unknown', os: 'unknown' },
          annotations: {
            'vnd.docker.reference.digest': IMAGE,
            'vnd.docker.reference.type': 'attestation-manifest',
          },
        },
        {
          mediaType: OCI_MANIFEST,
          digest: IMAGE,
          size: 1,
          platform: { architecture: ARCH, os: 'linux' },
        },
      ],
      annotations,
    })

    it('follows the platform manifest and falls back to the index annotation', async () => {
      const seen = serve({
        '/v2/app/manifests/sha256:idx': {
          digest: 'sha256:idx',
          body: index({ [REVISION]: 'from-index', [SOURCE]: 'https://github.com/o/app' }),
        },
        [`/v2/app/manifests/${IMAGE}`]: { digest: IMAGE, body: manifest() },
        [`/v2/app/blobs/${CFG}`]: { body: railpackConfig },
      })
      expect(await imageInfo('app', 'sha256:idx')).toEqual({
        digest: 'sha256:idx',
        revision: 'from-index',
        sourceUrl: 'https://github.com/o/app',
        createdAt: new Date('2026-09-10T12:00:00Z'),
      })
      expect(seen).not.toContain(`/v2/app/manifests/${ATTESTATION}`)
    })

    it("prefers the platform manifest's annotation over the index's", async () => {
      serve({
        '/v2/app/manifests/latest': {
          digest: 'sha256:idx',
          body: index({ [REVISION]: 'from-index' }),
        },
        [`/v2/app/manifests/${IMAGE}`]: {
          digest: IMAGE,
          body: manifest({ [REVISION]: 'from-manifest' }),
        },
        [`/v2/app/blobs/${CFG}`]: { body: railpackConfig },
      })
      expect((await imageInfo('app', 'latest')).revision).toBe('from-manifest')
    })

    it('skips an entry whose digest is not a sha256 digest, for the next real one', async () => {
      const platform = { architecture: ARCH, os: 'linux' }
      const seen = serve({
        '/v2/app/manifests/latest': {
          digest: 'sha256:idx',
          body: index({ [REVISION]: 'from-index' }, [
            { mediaType: OCI_MANIFEST, digest: '../../other/manifests/latest', platform },
            { mediaType: OCI_MANIFEST, digest: `${IMAGE}?x=1`, platform },
            { mediaType: OCI_MANIFEST, digest: IMAGE, platform },
          ]),
        },
        [`/v2/app/manifests/${IMAGE}`]: {
          digest: IMAGE,
          body: manifest({ [REVISION]: 'from-manifest' }),
        },
        [`/v2/app/blobs/${CFG}`]: { body: railpackConfig },
      })
      expect((await imageInfo('app', 'latest')).revision).toBe('from-manifest')
      expect(seen).toEqual([
        '/v2/app/manifests/latest',
        `/v2/app/manifests/${IMAGE}`,
        `/v2/app/blobs/${CFG}`,
      ])
    })

    it('pulls nothing more when no entry has a real digest', async () => {
      const seen = serve({
        '/v2/app/manifests/latest': {
          digest: 'sha256:idx',
          body: index({ [REVISION]: 'from-index' }, [
            { digest: '../../../v2/other/blobs/x', platform: { architecture: ARCH, os: 'linux' } },
          ]),
        },
      })
      expect(await imageInfo('app', 'latest')).toEqual({
        digest: 'sha256:idx',
        revision: 'from-index',
        sourceUrl: null,
        createdAt: null,
      })
      expect(seen).toEqual(['/v2/app/manifests/latest'])
    })
  })

  it('returns nulls for a reference the registry does not have', async () => {
    serve({})
    expect(await imageInfo('app', 'gone')).toEqual({
      digest: null,
      revision: null,
      sourceUrl: null,
      createdAt: null,
    })
  })
})
