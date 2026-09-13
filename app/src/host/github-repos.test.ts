import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The create form's picker: the App's installation by default, the
// GITHUB_REPO_TOKEN override when one is set, and an error that empties the
// list rather than shortening it.

const h = vi.hoisted(() => ({
  token: '',
  listed: undefined as unknown,
  ctxMade: 0,
}))

vi.mock('./keys', () => ({ key: (name: string) => (name === 'GITHUB_REPO_TOKEN' ? h.token : '') }))
vi.mock('../core/ctx', () => ({
  makeCtx: async () => {
    h.ctxMade++
    return {}
  },
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
  h.token = ''
  h.ctxMade = 0
  h.listed = { ok: true, total: 1, repos: [installed('iris')] }
  fetchMock = vi.fn(async () => new Response('[]', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listRepos', () => {
  it('lists the installation, newest push first, and spends no PAT', async () => {
    h.listed = {
      ok: true,
      total: 2,
      repos: [
        installed('argus', { pushedAt: '2026-01-01T00:00:00Z' }),
        installed('iris', { pushedAt: '2026-09-10T00:00:00Z' }),
      ],
    }
    const r = await listRepos()
    expect(r.source).toBe('app')
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

  it('asks the account instead when GITHUB_REPO_TOKEN overrides it', async () => {
    h.token = 'ghp_override'
    fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              name: 'santree',
              description: '',
              private: false,
              archived: true,
              language: 'Swift',
              pushed_at: '2026-08-01T00:00:00Z',
              html_url: 'https://github.com/octo/santree',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const r = await listRepos()
    expect(r.source).toBe('token')
    expect(r.error).toBeNull()
    expect(r.repos).toEqual([
      {
        name: 'santree',
        description: null,
        private: false,
        archived: true,
        language: 'Swift',
        pushedAt: '2026-08-01T00:00:00Z',
        htmlUrl: 'https://github.com/octo/santree',
      },
    ])
    // The installation is not consulted at all, so no ctx is built for it.
    expect(h.ctxMade).toBe(0)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('https://api.github.com/user/repos')
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer ghp_override')
  })

  it('names the override when the override is what GitHub refused', async () => {
    h.token = 'ghp_override'
    fetchMock = vi.fn(async () => new Response('{}', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await listRepos()
    expect(r.repos).toEqual([])
    expect(r.error).toMatch(/GITHUB_REPO_TOKEN/)
    expect(r.error).toMatch(/401/)
  })
})
