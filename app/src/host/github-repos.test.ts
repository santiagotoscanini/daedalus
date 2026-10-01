import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The create form's picker: the App's installation, and an error that empties
// the list rather than shortening it.

const h = vi.hoisted(() => ({
  listed: undefined as unknown,
}))

vi.mock('../core/ctx', () => ({
  makeCtx: async () => ({}),
}))
vi.mock('../core/github-app', () => ({ listInstallationRepos: async () => h.listed }))

const { listRepos } = await import('./github-repos')

const installed = (name: string, over: Record<string, unknown> = {}) => ({
  id: 1,
  name,
  fullName: `octo/${name}`,
  private: true,
  archived: false,
  defaultBranch: 'main',
  htmlUrl: `https://github.com/octo/${name}`,
  pushedAt: '2026-09-10T00:00:00Z',
  description: `the ${name} app`,
  language: 'TypeScript',
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  h.listed = { ok: true, total: 1, repos: [installed('iris')] }
  fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listRepos', () => {
  it('lists the installation, newest push first', async () => {
    h.listed = {
      ok: true,
      total: 2,
      repos: [
        installed('argus', { pushedAt: '2026-01-01T00:00:00Z' }),
        installed('iris', { pushedAt: '2026-09-10T00:00:00Z' }),
      ],
    }
    const r = await listRepos()
    expect(r.error).toBeNull()
    expect(r.repos.map((x) => x.name)).toEqual(['iris', 'argus'])
    expect(r.repos[0]).toEqual({
      name: 'iris',
      description: 'the iris app',
      private: true,
      archived: false,
      language: 'TypeScript',
      pushedAt: '2026-09-10T00:00:00Z',
      htmlUrl: 'https://github.com/octo/iris',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('empties the list and says why when the App cannot be asked', async () => {
    h.listed = { ok: false, reason: 'GitHub did not answer within 10 seconds.', retryAfterMs: null }
    const r = await listRepos()
    // Never a short list passed off as the whole one.
    expect(r.repos).toEqual([])
    expect(r.error).toBe('GitHub did not answer within 10 seconds.')
  })
})
