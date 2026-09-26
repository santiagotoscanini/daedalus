import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManualPin } from '../../host/contract/domains/images'
import type { ImageFreshness } from './images'

// The pins no button moves (fleet.manualPins), as rows and as notes.
//
// What would go wrong quietly: a commit pin rendered with a registry verdict it
// never had, a commit shown as forty characters, a base image's row asking
// GitHub about the CONTAINER it builds instead of the project it names — and a
// manual id that shares a name with a container reading the container's notes.
// The GitHub readers are mocked so each case can say exactly which repo, which
// version and which branch were asked about.

const h = vi.hoisted(() => ({
  manual: {} as Record<string, ManualPin>,
  freshness: {} as Record<string, ImageFreshness>,
  asked: [] as unknown[],
}))

vi.mock('../../host/contract/domains/images', () => ({
  imagePins: async () => ({}),
  manualPins: async () => h.manual,
}))

vi.mock('./images', () => ({
  imageFreshness: async (id: string) => h.freshness[id] ?? null,
  imageVersion: async () => ({ version: '9.9.9', source: 'pin', revision: 'c0ffee1' }),
}))

vi.mock('./image-repos', () => ({
  releaseSourceFor: async (container: string) =>
    container === 'pg' ? { repo: 'example/postgres-notes' } : null,
}))

vi.mock('./github', () => ({
  EMPTY_GAP: { installed: null, latest: null, behind: [], releases: [], note: null },
  versionGap: async (repo: string, installed: string | null) => {
    h.asked.push({ kind: 'releases', repo, installed })
    return { installed, latest: null, behind: [], releases: [], note: null }
  },
  commitsSince: async (repo: string, sha: string | null, branch: string) => {
    h.asked.push({ kind: 'commits', repo, sha, branch })
    return { running: sha, builtOn: null, behind: [], note: null }
  },
}))

const { loadUpdateNotes, manualRows } = await import('./update-rows')

const pin = (over: Partial<ManualPin> = {}): ManualPin => ({
  image: 'docker.io/library/node:24-slim',
  repo: 'docker.io/library/node',
  tag: '24-slim',
  digest: 'sha256:aaaa',
  version: '24-slim',
  upstream: 'nodejs/node',
  branch: null,
  parts: {},
  containers: [],
  note: null,
  pinnedIn: { repo: 'engine', path: 'nix/stacks/daedalus/build-agent.nix' },
  ...over,
})

const probe = (over: Partial<ImageFreshness> = {}): ImageFreshness => ({
  image: 'docker.io/library/node:24-slim',
  tag: '24-slim',
  pinnedDigest: 'sha256:aaaa',
  remoteDigest: 'sha256:aaaa',
  moved: false,
  remoteCreated: null,
  remoteVersion: null,
  newerTag: null,
  candidates: [],
  checkedAt: '2026-09-26T04:00:00Z',
  error: null,
  stale: false,
  ...over,
})

const COMMIT = 'b553f84a32f580b4303297df5567f25912b59d93'

beforeEach(() => {
  h.manual = {}
  h.freshness = {}
  h.asked = []
})

describe('manualRows', () => {
  it('an image pin carries the probe verdict, the file it lives in, and no button', async () => {
    h.manual = { 'build-checks-node': pin() }
    h.freshness = { 'build-checks-node': probe({ moved: true, remoteDigest: 'sha256:bbbb' }) }
    const [r] = await manualRows()
    expect(r).toMatchObject({
      kind: 'manual',
      container: 'build-checks-node',
      verdict: 'tag-moved',
      running: { version: '24-slim', source: 'pin' },
      pinnedIn: { repo: 'engine', path: 'nix/stacks/daedalus/build-agent.nix' },
      hasNotes: true,
    })
    expect(r).not.toHaveProperty('updatable')
  })

  it('a commit pin shows the short commit and claims no registry verdict', async () => {
    h.manual = {
      'litellm-pgvector': pin({
        image: null,
        repo: null,
        tag: null,
        digest: null,
        version: COMMIT,
        upstream: 'example/connector',
        branch: 'main',
        pinnedIn: { repo: 'config', path: 'stacks/litellm-pgvector/litellm-pgvector.nix' },
      }),
    }
    // Even a stray probe row under the same id is not this pin's to read.
    h.freshness = { 'litellm-pgvector': probe({ newerTag: '25-slim' }) }
    const [r] = await manualRows()
    expect(r?.running).toEqual({ version: 'b553f84', source: 'pin', revision: 'b553f84' })
    expect(r?.freshness).toBeNull()
    expect(r?.verdict).toBe('unknown')
  })

  it('sorts behind first, then by id', async () => {
    h.manual = { a: pin(), b: pin(), c: pin() }
    h.freshness = { c: probe({ newerTag: '26-slim' }), a: probe() }
    expect((await manualRows()).map((r) => [r.container, r.verdict])).toEqual([
      ['c', 'newer-tag'],
      ['b', 'unknown'],
      ['a', 'current'],
    ])
  })

  it('parts and the note ride along; no upstream and no container means no notes', async () => {
    h.manual = {
      railpack: pin({
        upstream: null,
        parts: { cli: '0.39.0', mise: '2026.8.16' },
        note: 'as a set',
      }),
    }
    const [r] = await manualRows()
    expect(r).toMatchObject({ parts: { cli: '0.39.0', mise: '2026.8.16' }, note: 'as a set' })
    expect(r?.hasNotes).toBe(false)
  })
})

describe('loadUpdateNotes for a manual pin', () => {
  it('reads the releases of its upstream at its own version', async () => {
    h.manual = { railpack: pin({ upstream: 'example/railpack', version: '0.39.0' }) }
    const n = await loadUpdateNotes('railpack')
    expect(h.asked).toEqual([{ kind: 'releases', repo: 'example/railpack', installed: '0.39.0' }])
    expect(n.repo).toBe('example/railpack')
    expect(n.build).toBeNull()
  })

  it('a branch pin compares its FULL commit on that branch', async () => {
    h.manual = {
      'litellm-pgvector': pin({ version: COMMIT, upstream: 'example/connector', branch: 'main' }),
    }
    const n = await loadUpdateNotes('litellm-pgvector')
    expect(h.asked).toEqual([
      { kind: 'commits', repo: 'example/connector', sha: COMMIT, branch: 'main' },
    ])
    expect(n.gap).toBeNull()
  })

  it("without an upstream it borrows the first container's source, at the pin's version", async () => {
    h.manual = {
      'pg-pgvector': pin({ upstream: null, version: '18.4-alpine', containers: ['pg'] }),
    }
    await loadUpdateNotes('pg-pgvector')
    expect(h.asked).toEqual([
      { kind: 'releases', repo: 'example/postgres-notes', installed: '18.4-alpine' },
    ])
  })

  it('a name that is not a manual pin is read as a container', async () => {
    await loadUpdateNotes('pg')
    // The container's own running version, not any pin's.
    expect(h.asked).toEqual([
      { kind: 'releases', repo: 'example/postgres-notes', installed: '9.9.9' },
    ])
  })
})
