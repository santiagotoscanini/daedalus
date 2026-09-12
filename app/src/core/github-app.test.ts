import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from './ctx'
import {
  ghApp,
  listInstallationRepos,
  MIN_BACKOFF_MS,
  repoById,
  requestTokenRefresh,
  retryAfterMs,
} from './github-app'

// The one door to GitHub as the installation: the token stays inside, a 401
// asks the host for a new one (debounced), rate limits come back as a wait,
// and nothing throws.

const TOKEN = `ghs${'_'}${'Q9w8E7r6'.repeat(5)}`

let dir: string
let fetchMock: ReturnType<typeof vi.fn>

const ctx = {
  env: (name: string) =>
    name === 'GITHUB_TOKEN_PATH' ? join(dir, 'installation.json') : undefined,
} as unknown as Ctx

async function publish(token: string | null) {
  await writeFile(
    join(dir, 'installation.json'),
    JSON.stringify({
      version: 1,
      state: token === null ? 'not-installed' : 'ok',
      installationId: 81,
      account: { login: 'octo', id: 4242 },
      repositorySelection: 'selected',
      token,
      expiresAt: new Date(Date.now() + 55 * 60_000).toISOString(),
      mintedAt: new Date().toISOString(),
    }),
  )
}

const requested = () =>
  stat(join(dir, 'apply', 'github-token-request.json')).then(
    () => true,
    () => false,
  )

function answer(fn: (url: string, init: RequestInit) => Response | Promise<Response>) {
  fetchMock = vi.fn(async (input: string | URL, init: RequestInit = {}) => fn(String(input), init))
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gh-app-'))
  process.env.APPLY_DIR = join(dir, 'apply')
  delete (globalThis as { daedalusGithubTokenRefreshAt?: number }).daedalusGithubTokenRefreshAt
  await publish(TOKEN)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.APPLY_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('ghApp', () => {
  it('sends the installation token to api.github.com and keeps it out of the result', async () => {
    answer(() => Response.json({ ok: 1 }))
    const r = await ghApp(ctx, '/installation/repositories')
    expect(r).toMatchObject({ status: 200, body: { ok: 1 }, error: null, retryAfterMs: null })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.github.com/installation/repositories')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(init.redirect).toBe('manual')
    expect(JSON.stringify(r)).not.toContain(TOKEN)
  })

  it('refuses anything but an API path, sending nothing', async () => {
    answer(() => Response.json({}))
    for (const path of ['https://evil.test/x', '//evil.test/x', 'repos']) {
      expect((await ghApp(ctx, path)).error).toBe('invalid-path')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('without a usable token sends nothing and asks the host for one', async () => {
    await publish(null)
    answer(() => Response.json({}))
    expect(await ghApp(ctx, '/installation/repositories')).toMatchObject({
      status: null,
      error: 'no-token',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await requested()).toBe(true)
  })

  it('asks for a new token on a 401, at most once a minute, and does not retry', async () => {
    answer(() => new Response('{"message":"Bad credentials"}', { status: 401 }))
    expect((await ghApp(ctx, '/installation/repositories')).status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const first = JSON.parse(
      await readFile(join(dir, 'apply', 'github-token-request.json'), 'utf8'),
    )
    expect(first.version).toBe(1)

    expect(await requestTokenRefresh()).toBe(false)
    await ghApp(ctx, '/installation/repositories')
    const second = JSON.parse(
      await readFile(join(dir, 'apply', 'github-token-request.json'), 'utf8'),
    )
    expect(second.id).toBe(first.id)
  })

  it('returns a wait on rate limits and nothing on a plain 403', async () => {
    const now = Date.parse('2026-09-11T20:00:00Z')
    const h = (o: Record<string, string>) => new Headers(o)
    expect(retryAfterMs(429, h({ 'retry-after': '120' }), now)).toBe(120_000)
    expect(retryAfterMs(403, h({ 'retry-after': '5' }), now)).toBe(MIN_BACKOFF_MS)
    expect(
      retryAfterMs(
        403,
        h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) }),
        now,
      ),
    ).toBe(600_000)
    expect(retryAfterMs(429, h({}), now)).toBe(MIN_BACKOFF_MS)
    expect(retryAfterMs(403, h({}), now)).toBeNull()
    expect(retryAfterMs(500, h({ 'retry-after': '120' }), now)).toBeNull()

    answer(() => new Response('{}', { status: 429, headers: { 'retry-after': '90' } }))
    expect(await ghApp(ctx, '/installation/repositories')).toMatchObject({
      status: 429,
      retryAfterMs: 90_000,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never throws: no answer is a null status', async () => {
    answer(() => {
      throw new TypeError('fetch failed')
    })
    expect(await ghApp(ctx, '/x')).toMatchObject({ status: null, error: 'unreachable' })
    answer(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    expect(await ghApp(ctx, '/x')).toMatchObject({ status: null, error: 'timeout' })
    answer(() => new Response('not json', { status: 200 }))
    expect(await ghApp(ctx, '/x')).toMatchObject({ status: 200, body: null })
  })
})

describe('listInstallationRepos', () => {
  const repo = (id: number, name: string) => ({
    id,
    name,
    full_name: `octo/${name}`,
    private: true,
    default_branch: 'main',
    html_url: `https://github.com/octo/${name}`,
    pushed_at: '2026-09-10T00:00:00Z',
  })

  it('lists every repository by name', async () => {
    answer(() =>
      Response.json({ total_count: 2, repositories: [repo(2, 'iris'), repo(1, 'argus')] }),
    )
    const r = await listInstallationRepos(ctx)
    expect(r).toMatchObject({ ok: true, total: 2 })
    expect(r.ok && r.repos.map((x) => x.name)).toEqual(['argus', 'iris'])
  })

  it('says why when it cannot', async () => {
    answer(() => new Response('{}', { status: 403, headers: { 'retry-after': '120' } }))
    expect(await listInstallationRepos(ctx)).toMatchObject({ ok: false, retryAfterMs: 120_000 })
  })

  it('carries the description and language the create form renders', async () => {
    answer(() =>
      Response.json({
        total_count: 1,
        repositories: [{ ...repo(2, 'iris'), description: 'QR codes', language: 'TypeScript' }],
      }),
    )
    const r = await listInstallationRepos(ctx)
    expect(r.ok && r.repos[0]).toMatchObject({ description: 'QR codes', language: 'TypeScript' })
  })

  it('reads an empty description as none rather than as an empty string', async () => {
    answer(() =>
      Response.json({ total_count: 1, repositories: [{ ...repo(2, 'iris'), description: '' }] }),
    )
    const r = await listInstallationRepos(ctx)
    expect(r.ok && r.repos[0]).toMatchObject({ description: null, language: null })
  })
})

describe('repoById', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    id: 4242,
    full_name: 'octo/iris-web',
    default_branch: 'trunk',
    ...over,
  })

  it("answers with the repository's name today, split for the API paths", async () => {
    answer((url) => {
      expect(url).toBe('https://api.github.com/repositories/4242')
      return Response.json(body())
    })
    expect(await repoById(ctx, 4242)).toEqual({
      ok: true,
      repo: {
        id: 4242,
        fullName: 'octo/iris-web',
        owner: 'octo',
        name: 'iris-web',
        defaultBranch: 'trunk',
      },
    })
  })

  it('refuses an answer about another repository', async () => {
    answer(() => Response.json(body({ id: 7 })))
    expect(await repoById(ctx, 4242)).toMatchObject({ ok: false })
  })

  it('refuses a full_name that is not owner/name', async () => {
    answer(() => Response.json(body({ full_name: 'iris-web' })))
    expect(await repoById(ctx, 4242)).toMatchObject({ ok: false })
  })

  it('falls back to main when GitHub names no default branch', async () => {
    answer(() => Response.json(body({ default_branch: null })))
    expect(await repoById(ctx, 4242)).toMatchObject({ ok: true, repo: { defaultBranch: 'main' } })
  })

  it('says why when GitHub refuses, and asks nothing for a non-id', async () => {
    answer(() => new Response('{}', { status: 404 }))
    expect(await repoById(ctx, 4242)).toMatchObject({ ok: false, reason: /404/ })
    fetchMock.mockClear()
    expect(await repoById(ctx, 0)).toMatchObject({ ok: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
