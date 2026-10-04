import { beforeEach, describe, expect, it, vi } from 'vitest'
import { siteFrom } from '../site'

// Whether an app's first image exists: which reference is asked, and what the
// registry says. It is mocked at the module boundary; the presence answer is
// per reference.

const h = vi.hoisted(() => ({
  presence: new Map<string, 'present' | 'missing' | 'unknown'>(),
  asked: [] as string[],
}))

vi.mock('../../host/registry', () => ({
  imagePresence: async (repo: string, reference: string) => {
    const key = `${repo}:${reference}`
    h.asked.push(key)
    return h.presence.get(key) ?? 'missing'
  },
}))

const { firstImage, gatedReference } = await import('./image-gate')

const site = siteFrom({ baseDomain: 'example.org', registryHost: 'registry.example.org' })
const app = (
  over: Partial<{ image: string | null; sourceMode: string; managedInNix: boolean }> = {},
) => ({
  name: 'sankofa',
  image: null,
  sourceMode: 'registry',
  managedInNix: false,
  ...over,
})

beforeEach(() => {
  h.presence = new Map()
  h.asked = []
})

describe('gatedReference', () => {
  it('asks the default image at latest', () => {
    expect(gatedReference(site, app())).toEqual({
      image: 'registry.example.org/sankofa:latest',
      repo: 'sankofa',
      reference: 'latest',
    })
  })

  it('asks an override on the box registry at the reference it names', () => {
    expect(gatedReference(site, app({ image: 'registry.example.org/sankofa:sha-abc' }))).toEqual(
      expect.objectContaining({ repo: 'sankofa', reference: 'sha-abc' }),
    )
    const digest = `sha256:${'a'.repeat(64)}`
    expect(
      gatedReference(site, app({ image: `registry.example.org/forks/sankofa@${digest}` })),
    ).toEqual(expect.objectContaining({ repo: 'forks/sankofa', reference: digest }))
  })

  it('leaves an override elsewhere, a local app and a nix entry unchecked', () => {
    expect(gatedReference(site, app({ image: 'ghcr.io/someone/sankofa:latest' }))).toBeNull()
    expect(gatedReference(site, app({ sourceMode: 'local' }))).toBeNull()
    expect(gatedReference(site, app({ managedInNix: true }))).toBeNull()
  })
})

describe('firstImage', () => {
  it('reads the registry, and says unchecked for an image it cannot ask', async () => {
    h.presence.set('sankofa:latest', 'present')
    expect(await firstImage(site, app())).toBe('present')
    expect(await firstImage(site, app({ image: 'ghcr.io/x/y:latest' }))).toBe('unchecked')
    expect(h.asked).toEqual(['sankofa:latest'])
  })

  it('says missing for an image the registry does not hold', async () => {
    expect(await firstImage(site, app())).toBe('missing')
  })
})
