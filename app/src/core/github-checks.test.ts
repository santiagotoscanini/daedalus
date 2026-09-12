import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from './ctx'
import type { GhResult } from './github-app'

// The typed writes to GitHub. ghApp is mocked: these tests pin the request
// each wrapper sends (method, path, GitHub's field names) and how each answer
// maps to ok / failure.

const h = vi.hoisted(() => ({
  calls: [] as { path: string; method: string; body: Record<string, unknown> }[],
  answer: null as unknown as (path: string, method: string) => GhResult,
}))

vi.mock('./github-app', () => ({
  ghApp: async (_ctx: unknown, path: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    h.calls.push({ path, method, body: JSON.parse(String(init.body ?? '{}')) })
    return h.answer(path, method)
  },
}))

const {
  clampChars,
  createCheckRun,
  createDeployment,
  createDeploymentStatus,
  failureOf,
  githubTime,
  updateCheckRun,
} = await import('./github-checks')

const ctx = {} as Ctx
const repo = { owner: 'octo', repo: 'iris' }
const SHA = 'a'.repeat(40)

function res(status: number | null, body: unknown = null, retryAfterMs: number | null = null) {
  return {
    status,
    body,
    headers: new Headers(),
    retryAfterMs,
    error: status === null ? 'unreachable' : null,
  } as GhResult
}

beforeEach(() => {
  h.calls = []
  h.answer = () => res(201, { id: 9, html_url: 'https://github.com/octo/iris/runs/9' })
})

describe('createCheckRun', () => {
  it('posts the daedalus run in progress with GitHub field names', async () => {
    const r = await createCheckRun(ctx, repo, {
      headSha: SHA,
      buildId: 'b-1',
      detailsUrl: 'https://cp.example.test/apps/iris/builds/b-1',
      startedAt: new Date('2026-09-12T10:00:00.123Z'),
      output: { title: 't', summary: 's' },
    })
    expect(r).toEqual({
      ok: true,
      value: { id: 9, htmlUrl: 'https://github.com/octo/iris/runs/9' },
    })
    expect(h.calls).toEqual([
      {
        path: '/repos/octo/iris/check-runs',
        method: 'POST',
        body: {
          name: 'daedalus',
          head_sha: SHA,
          external_id: 'b-1',
          status: 'in_progress',
          started_at: '2026-09-12T10:00:00Z',
          details_url: 'https://cp.example.test/apps/iris/builds/b-1',
          output: { title: 't', summary: 's' },
        },
      },
    ])
  })

  it('creates a completed run when given a conclusion, and omits a missing details_url', async () => {
    await createCheckRun(ctx, repo, {
      headSha: SHA,
      buildId: 'b-1',
      detailsUrl: null,
      startedAt: new Date('2026-09-12T10:00:00Z'),
      output: { title: 't', summary: 's' },
      conclusion: 'failure',
      completedAt: new Date('2026-09-12T10:05:00Z'),
    })
    const body = h.calls[0]?.body
    expect(body).toMatchObject({
      status: 'completed',
      conclusion: 'failure',
      completed_at: '2026-09-12T10:05:00Z',
    })
    expect(body).not.toHaveProperty('details_url')
  })

  it('refuses a name that would change the path, without calling GitHub', async () => {
    for (const bad of [
      { owner: 'octo', repo: '../x' },
      { owner: 'oc/to', repo: 'iris' },
      { owner: 'octo', repo: '..' },
    ]) {
      const r = await createCheckRun(ctx, bad, {
        headSha: SHA,
        buildId: 'b',
        detailsUrl: null,
        startedAt: new Date(),
        output: { title: 't', summary: 's' },
      })
      expect(r).toMatchObject({ ok: false, failure: 'invalid-path' })
    }
    expect(h.calls).toEqual([])
  })

  it('maps failures, rate limits first', async () => {
    h.answer = () => res(403, { message: 'x' }, 60_000)
    const r = await createCheckRun(ctx, repo, {
      headSha: SHA,
      buildId: 'b',
      detailsUrl: null,
      startedAt: new Date(),
      output: { title: 't', summary: 's' },
    })
    expect(r).toEqual({ ok: false, failure: 'rate-limited', status: 403, retryAfterMs: 60_000 })
  })
})

describe('updateCheckRun', () => {
  it('patches the run; a conclusion completes it', async () => {
    h.answer = () => res(200, { id: 9 })
    const r = await updateCheckRun(ctx, repo, 9, {
      conclusion: 'success',
      completedAt: new Date('2026-09-12T10:05:00.999Z'),
      output: { title: 't', summary: 's', text: 'x' },
    })
    expect(r.ok).toBe(true)
    expect(h.calls[0]).toEqual({
      path: '/repos/octo/iris/check-runs/9',
      method: 'PATCH',
      body: {
        status: 'completed',
        conclusion: 'success',
        completed_at: '2026-09-12T10:05:00Z',
        output: { title: 't', summary: 's', text: 'x' },
      },
    })
  })

  it('refuses a non-id', async () => {
    expect(await updateCheckRun(ctx, repo, 0, { status: 'in_progress' })).toMatchObject({
      ok: false,
      failure: 'invalid-path',
    })
    expect(h.calls).toEqual([])
  })
})

describe('createDeployment', () => {
  it('posts a production Deployment of the commit that waits on nothing', async () => {
    h.answer = () => res(201, { id: 555 })
    const r = await createDeployment(ctx, repo, {
      sha: SHA,
      buildId: 'b-1',
      description: 'Built on s2-server',
    })
    expect(r).toEqual({ ok: true, value: { id: 555 } })
    expect(h.calls[0]).toEqual({
      path: '/repos/octo/iris/deployments',
      method: 'POST',
      body: {
        ref: SHA,
        environment: 'production',
        required_contexts: [],
        auto_merge: false,
        transient_environment: false,
        production_environment: true,
        description: 'Built on s2-server',
        payload: { buildId: 'b-1' },
      },
    })
  })

  it('a 202 merge answer created nothing; a 409 is a conflict', async () => {
    h.answer = () => res(202, { message: 'Auto-merged main into topic on deployment.' })
    expect(await createDeployment(ctx, repo, { sha: SHA, buildId: 'b', description: 'd' })).toEqual(
      { ok: false, failure: 'not-created', status: 202, retryAfterMs: null },
    )
    h.answer = () => res(409, { message: 'Conflict' })
    expect(await createDeployment(ctx, repo, { sha: SHA, buildId: 'b', description: 'd' })).toEqual(
      { ok: false, failure: 'conflict', status: 409, retryAfterMs: null },
    )
  })
})

describe('createDeploymentStatus', () => {
  it('posts state, urls and a description clamped to 140 characters', async () => {
    await createDeploymentStatus(ctx, repo, 555, {
      state: 'success',
      description: 'x'.repeat(300),
      environmentUrl: 'https://iris.example.test',
      logUrl: 'https://cp.example.test/apps/iris/builds/b-1',
    })
    const call = h.calls[0]
    expect(call?.path).toBe('/repos/octo/iris/deployments/555/statuses')
    expect(call?.body).toMatchObject({
      state: 'success',
      environment_url: 'https://iris.example.test',
      log_url: 'https://cp.example.test/apps/iris/builds/b-1',
    })
    expect(String(call?.body.description).length).toBe(140)
  })

  it('omits urls it does not have', async () => {
    await createDeploymentStatus(ctx, repo, 555, {
      state: 'error',
      description: 'no deploy landed',
    })
    expect(h.calls[0]?.body).toEqual({ state: 'error', description: 'no deploy landed' })
  })
})

describe('helpers', () => {
  it('clampChars never splits a surrogate pair', () => {
    const s = `${'a'.repeat(138)}😀😀`
    const out = clampChars(s, 140)
    expect(out.length).toBeLessThanOrEqual(140)
    expect(out).toBe(`${'a'.repeat(138)}…`)
    expect(clampChars('short', 140)).toBe('short')
  })

  it('githubTime drops milliseconds', () => {
    expect(githubTime(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T03:04:05Z')
  })

  it('failureOf names what went wrong', () => {
    expect(failureOf(res(null))).toBe('unreachable')
    expect(failureOf(res(401))).toBe('unauthorized')
    expect(failureOf(res(422))).toBe('invalid')
    expect(failureOf(res(502))).toBe('server')
    expect(failureOf(res(429, null, 60_000))).toBe('rate-limited')
    expect(failureOf(res(200))).toBe('unexpected')
  })
})
