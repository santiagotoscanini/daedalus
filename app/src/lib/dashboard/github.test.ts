import { afterEach, describe, expect, it, vi } from 'vitest'
import { cmp, versionGap } from './github'

describe('cmp', () => {
  it('orders plain semver numerically, not lexicographically', () => {
    expect(cmp('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(cmp('2.0.0', '1.9.9')).toBeGreaterThan(0)
    expect(cmp('1.2.3', '1.2.3')).toBe(0)
  })

  it('compares as many segments as the longer side — the *arr build number', () => {
    // Sonarr ships 4.0.19.2979-style tags where only the 4th segment moves.
    expect(cmp('4.0.19.2980', '4.0.19.2979')).toBeGreaterThan(0)
    expect(cmp('6.3.0.10514', '6.3.0')).toBeGreaterThan(0)
  })

  it('treats a missing segment as zero', () => {
    expect(cmp('1.2.3', '1.2.3.0')).toBe(0)
    expect(cmp('1.2', '1.2.0.0')).toBe(0)
  })
})

type FakeRelease = {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
}

function stubReleases(list: FakeRelease[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => list })),
  )
}

// Each test uses a distinct repo name: the module keeps a per-repo TTL cache,
// and a shared name would serve one test's stub to the next.
describe('versionGap', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports what is behind, oldest first, and the latest', async () => {
    stubReleases([
      { tag_name: 'v1.3.0', body: '' },
      { tag_name: 'v1.2.0', body: '' },
      { tag_name: 'v1.1.0', body: '' },
    ])
    const gap = await versionGap('t/behind', '1.1.0')
    expect(gap.installed).toBe('1.1.0')
    expect(gap.latest).toBe('1.3.0')
    expect(gap.behind).toEqual(['1.2.0', '1.3.0'])
    // The running release rides along so a current box still shows its notes.
    expect(gap.releases.map((r) => r.version)).toEqual(['1.3.0', '1.2.0', '1.1.0'])
    expect(gap.note).toBeNull()
  })

  it('drops drafts entirely and keeps prereleases out of the count', async () => {
    stubReleases([
      { tag_name: 'v2.1.0', draft: true },
      { tag_name: 'v2.0.1', prerelease: true },
      { tag_name: 'v2.0.0' },
    ])
    const gap = await versionGap('t/drafts', '2.0.0')
    expect(gap.latest).toBe('2.0.0')
    expect(gap.behind).toEqual([])
  })

  it('shows the notes of an installed prerelease — what did I last get', async () => {
    stubReleases([{ tag_name: 'v2.0.1', prerelease: true, body: '- fix' }, { tag_name: 'v2.0.0' }])
    const gap = await versionGap('t/prenotes', '2.0.1')
    expect(gap.releases.map((r) => r.version)).toContain('2.0.1')
  })

  it('ignores tags that do not match the version pattern', async () => {
    stubReleases([{ tag_name: 'stable' }, { tag_name: 'v1.0.0' }])
    const gap = await versionGap('t/tags', '1.0.0')
    expect(gap.latest).toBe('1.0.0')
  })

  it('honours a custom tag pattern — the n8n@x.y.z shape', async () => {
    stubReleases([{ tag_name: 'n8n@2.34.0' }, { tag_name: 'n8n@2.33.0' }])
    const gap = await versionGap('t/pattern', '2.33.0', { tag: /^n8n@(\d+\.\d+\.\d+)$/ })
    expect(gap.behind).toEqual(['2.34.0'])
  })

  it('confines the count to the running major when asked', async () => {
    stubReleases([{ tag_name: 'v2.1.0' }, { tag_name: 'v1.9.0' }, { tag_name: 'v2.0.0' }])
    const gap = await versionGap('t/major', '2.0.0', { sameMajor: true })
    expect(gap.behind).toEqual(['2.1.0'])
  })

  it('says GitHub refused rather than pretending current', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    )
    const gap = await versionGap('t/refused', '1.0.0')
    expect(gap.installed).toBe('1.0.0')
    expect(gap.note).toContain('rate limit')
    expect(gap.behind).toEqual([])
  })

  it('lists the newest releases when nothing can be named, only if asked', async () => {
    stubReleases([
      { tag_name: 'v3.1.0', body: '- x' },
      { tag_name: 'v3.0.0', body: '- y' },
    ])
    const silent = await versionGap('t/unknown-a', null)
    expect(silent.releases).toEqual([])
    const spoken = await versionGap('t/unknown-b', null, { notesWhenUnknown: true })
    expect(spoken.releases.map((r) => r.version)).toEqual(['3.1.0', '3.0.0'])
  })

  describe('byName — tags that changed scheme mid-stream', () => {
    // Hermes Agent: calendar tags with the engine number in the name, then a
    // plain `v0.21.N` tag whose name has no calendar part.
    const mixed: FakeRelease[] = [
      { tag_name: 'v0.21.6', name: 'Hermes Agent v0.21.6', body: '- six' },
      { tag_name: 'v2026.9.24', name: 'Hermes Agent v0.21.5 (v2026.9.24)', body: '- five' },
      { tag_name: 'v2026.9.21', name: 'Hermes Agent v0.21.4 (v2026.9.21)', body: '- four' },
    ]
    const opts = { tag: /^v(\d{4}\.\d{1,2}\.\d+)$/, byName: /^Hermes Agent v(\d+\.\d+\.\d+)/ }

    it('orders a calendar pin against a newer semver-tagged release', async () => {
      stubReleases(mixed)
      const gap = await versionGap('t/by-name-behind', '2026.9.24', opts)
      expect(gap.installed).toBe('0.21.5')
      expect(gap.latest).toBe('0.21.6')
      expect(gap.behind).toEqual(['0.21.6'])
      expect(gap.releases.map((r) => r.version)).toEqual(['0.21.6', '0.21.5'])
      expect(gap.note).toBeNull()
    })

    it('accepts the pin with its v prefix and reads current on the newest', async () => {
      stubReleases(mixed)
      const gap = await versionGap('t/by-name-current', 'v0.21.6', opts)
      expect(gap.installed).toBe('0.21.6')
      expect(gap.behind).toEqual([])
    })

    it('says so when the running tag is in no release, instead of reading current', async () => {
      stubReleases(mixed)
      const gap = await versionGap('t/by-name-unplaced', '2026.1.1', opts)
      expect(gap.installed).toBeNull()
      expect(gap.behind).toEqual([])
      expect(gap.latest).toBe('0.21.6')
      expect(gap.note).toContain('not among')
    })
  })
})
