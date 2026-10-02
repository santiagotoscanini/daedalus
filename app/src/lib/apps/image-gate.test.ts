import { beforeEach, describe, expect, it, vi } from 'vitest'
import { siteFrom } from '../site'

// The first-image gate: which reference is asked, which stage steps are gated,
// and what the save and the Apply refuse. The registry and the app row are
// mocked at the module boundary; the presence answer is per reference.

const h = vi.hoisted(() => ({
  presence: new Map<string, 'present' | 'missing' | 'unknown'>(),
  asked: [] as string[],
  app: undefined as
    | undefined
    | {
        name: string
        stage: string
        image: string | null
        sourceMode: string
        managedInNix: boolean
      },
}))

vi.mock('../../host/registry', () => ({
  imagePresence: async (repo: string, reference: string) => {
    const key = `${repo}:${reference}`
    h.asked.push(key)
    return h.presence.get(key) ?? 'missing'
  },
}))
vi.mock('../repo/apps', () => ({ getApp: async () => h.app }))

const {
  applyImageBlockers,
  firstImage,
  gatedReference,
  imageRefusal,
  needsFirstImage,
  stageChangeRefusal,
} = await import('./image-gate')

const site = siteFrom({ baseDomain: 'example.org', registryHost: 'registry.example.org' })
const app = (over: Partial<NonNullable<typeof h.app>> = {}) => ({
  name: 'sankofa',
  stage: 'declared',
  image: null,
  sourceMode: 'registry',
  managedInNix: false,
  ...over,
})

beforeEach(() => {
  h.presence = new Map()
  h.asked = []
  h.app = undefined
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

describe('needsFirstImage', () => {
  it.each([
    ['declared', 'off', true],
    ['declared', 'lab', true],
    ['declared', 'live', true],
    [null, 'lab', true],
    [null, 'declared', false],
    ['declared', 'declared', false],
    ['off', 'lab', false],
    ['lab', 'declared', false],
  ] as const)('%s → %s: %s', (from, to, gated) => {
    expect(needsFirstImage(from, to)).toBe(gated)
  })
})

describe('firstImage and imageRefusal', () => {
  it('reads the registry, and says unchecked for an image it cannot ask', async () => {
    h.presence.set('sankofa:latest', 'present')
    expect(await firstImage(site, app())).toBe('present')
    expect(await firstImage(site, app({ image: 'ghcr.io/x/y:latest' }))).toBe('unchecked')
    expect(h.asked).toEqual(['sankofa:latest'])
  })

  it('refuses missing and unknown, in words without em dashes or exclamations', () => {
    for (const state of ['missing', 'unknown'] as const) {
      const reason = imageRefusal('sankofa', state)
      expect(reason).toContain('sankofa')
      expect(reason).not.toMatch(/[—!]/)
    }
    expect(imageRefusal('sankofa', 'present')).toBeNull()
    expect(imageRefusal('sankofa', 'unchecked')).toBeNull()
  })
})

describe('stageChangeRefusal (the save)', () => {
  const ctx = { site }

  it('refuses a declared app with no image a running rung', async () => {
    h.app = app()
    expect(await stageChangeRefusal(ctx, 'sankofa', 'lab')).toMatch(/no image/)
  })

  it('lets it through once the image exists', async () => {
    h.app = app()
    h.presence.set('sankofa:latest', 'present')
    expect(await stageChangeRefusal(ctx, 'sankofa', 'live')).toBeNull()
  })

  it('does not ask for a step that is not into running', async () => {
    h.app = app({ stage: 'lab' })
    expect(await stageChangeRefusal(ctx, 'sankofa', 'live')).toBeNull()
    h.app = app()
    expect(await stageChangeRefusal(ctx, 'sankofa', 'declared')).toBeNull()
    expect(h.asked).toEqual([])
  })
})

describe('applyImageBlockers (the Apply and its preview)', () => {
  it('blocks only the apps stepping into running without an image', async () => {
    h.presence.set('iris:latest', 'present')
    h.presence.set('argus:latest', 'unknown')
    const records = [
      app({ stage: 'lab' }), // declared on the box, promoted, no image
      app({ name: 'iris', stage: 'live' }), // new to the box, image present
      app({ name: 'hermes', stage: 'live' }), // already running: not asked
      app({ name: 'plutus', stage: 'declared' }), // stays declared: not asked
      app({ name: 'argus', stage: 'off' }), // registry did not answer
    ]
    const applied = new Map([
      ['sankofa', { stage: 'declared' }],
      ['hermes', { stage: 'lab' }],
      ['plutus', { stage: 'declared' }],
      ['argus', { stage: 'declared' }],
    ])
    const blocked = await applyImageBlockers(site, records, applied)
    expect(blocked).toHaveLength(2)
    expect(blocked[0]).toMatch(/^sankofa has no image/)
    expect(blocked[1]).toMatch(/argus/)
    expect(h.asked.sort()).toEqual(['argus:latest', 'iris:latest', 'sankofa:latest'])
  })
})
