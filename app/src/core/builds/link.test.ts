import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../ctx'

// Linking an app to its repository: the installed App's listing by name, the
// pin that is never overwritten, and a refusal a page can show.

const h = vi.hoisted(() => ({
  listing: { ok: true, repos: [], total: 0 } as
    | { ok: true; repos: { id: number; name: string; fullName: string }[]; total: number }
    | { ok: false; reason: string; retryAfterMs: number | null },
  pinned: new Map<string, number>(),
  listed: 0,
}))

vi.mock('../github-app', () => ({
  listInstallationRepos: async () => {
    h.listed++
    return h.listing
  },
}))
vi.mock('../../lib/repo/builds', () => ({
  pinGithubRepoId: async (appId: string, repoId: number) => {
    if (h.pinned.has(appId)) return false
    h.pinned.set(appId, repoId)
    return true
  },
}))
vi.mock('../../lib/repo/apps', () => ({
  getApp: async (name: string) => ({
    id: `app-${name}`,
    githubRepoId: h.pinned.get(`app-${name}`) ?? null,
  }),
}))

const { linkAppRepo } = await import('./link')

const ctx = {} as Ctx
const sankofa = { id: 'app-sankofa', name: 'sankofa', githubRepoId: null }
const repo = (id: number, name: string) => ({ id, name, fullName: `someone/${name}` })

beforeEach(() => {
  h.listing = { ok: true, repos: [repo(7, 'iris'), repo(42, 'Sankofa')], total: 2 }
  h.pinned = new Map()
  h.listed = 0
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

describe('linkAppRepo', () => {
  it('pins the repository the App lists under the app’s name, case-insensitively', async () => {
    expect(await linkAppRepo(ctx, sankofa)).toEqual({
      ok: true,
      value: { repoId: 42, fullName: 'someone/Sankofa' },
    })
    expect(h.pinned.get('app-sankofa')).toBe(42)
  })

  it('answers an existing pin without asking GitHub', async () => {
    expect(await linkAppRepo(ctx, { ...sankofa, githubRepoId: 99 })).toEqual({
      ok: true,
      value: { repoId: 99, fullName: null },
    })
    expect(h.listed).toBe(0)
  })

  it('says so plainly when the App cannot see the repository', async () => {
    h.listing = { ok: true, repos: [repo(7, 'iris')], total: 1 }
    const r = await linkAppRepo(ctx, sankofa)
    expect(r).toEqual({
      ok: false,
      reason: expect.stringMatching(/cannot see a repository named sankofa/),
    })
    expect(h.pinned.size).toBe(0)
  })

  it('passes a failed listing on as the reason', async () => {
    h.listing = { ok: false, reason: 'GitHub answered 502.', retryAfterMs: null }
    const r = await linkAppRepo(ctx, sankofa)
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).toContain('GitHub answered 502.')
  })

  it('takes a pin someone else wrote first as the answer, never overwriting it', async () => {
    h.pinned.set('app-sankofa', 13)
    expect(await linkAppRepo(ctx, sankofa)).toEqual({
      ok: true,
      value: { repoId: 13, fullName: null },
    })
    expect(h.pinned.get('app-sankofa')).toBe(13)
  })
})
