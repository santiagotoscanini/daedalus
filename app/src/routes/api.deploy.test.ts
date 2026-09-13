import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The door in front of the deploy trigger.
//
// /api/deploy is one of only two paths outside the Pocket ID gate
// (authBypassRule in stacks/daedalus/daedalus.nix) — zot cannot hold a
// passkey, so the endpoint carries its own X-Deploy-Token instead. The other
// such path has 670 lines of test devoted to its signature check; this one had
// its body guard tested and its token gate not.
//
// `authFailure` is correct today. The test is to keep it that way, because
// getting it wrong is invisible from both sides: an inverted condition hands a
// deploy trigger to anyone who can reach the container, and a deploy nobody
// asked for looks exactly like the 2-minute timer doing its job.
//
// So every assertion here is about the SIDE EFFECT, not the status code. A 401
// that still called requestDeploy would pass a status-only test and would have
// already started the rebuild of an app by the time the caller read the body.

const h = vi.hoisted(() => ({
  deploys: [] as { app: string; reason: string; actor: string }[],
  statusReads: 0,
  app: { name: 'anansi', sourceMode: 'registry' } as { name: string; sourceMode: string } | null,
}))

vi.mock('../host/deploy', () => ({
  requestDeploy: async (input: { app: string; reason: string; actor: string }) => {
    h.deploys.push(input)
    return 'deploy-id'
  },
  readDeployStatus: async () => {
    h.statusReads++
    return { id: null, app: null, state: 'idle', error: '', startedAt: null, finishedAt: null }
  },
}))
vi.mock('../lib/repo/apps', () => ({ getApp: async () => h.app ?? undefined }))
vi.mock('../host/app-icon', () => ({ forgetAppIcon: () => undefined }))

type Handler = (ctx: { request: Request }) => Promise<Response>
type RouteLike = { options?: { server?: { handlers?: { GET?: Handler; POST?: Handler } } } }

const TOKEN = 'a-deploy-token-with-some-length'
const URL_ = 'http://app-daedalus:3000/api/deploy'
const PUSH = JSON.stringify({ name: 'anansi', reference: 'latest' })

let previousToken: string | undefined

beforeEach(() => {
  previousToken = process.env.DEPLOY_HOOK_TOKEN
  process.env.DEPLOY_HOOK_TOKEN = TOKEN
  h.deploys = []
  h.statusReads = 0
  h.app = { name: 'anansi', sourceMode: 'registry' }
})

afterEach(() => {
  if (previousToken === undefined) delete process.env.DEPLOY_HOOK_TOKEN
  else process.env.DEPLOY_HOOK_TOKEN = previousToken
})

async function call(method: 'GET' | 'POST', token?: string) {
  const { Route } = (await import('./api.deploy')) as { Route: RouteLike }
  const handler = Route.options?.server?.handlers?.[method]
  if (!handler) throw new Error(`/api/deploy has no ${method} handler`)
  return handler({
    request: new Request(URL_, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { 'x-deploy-token': token }),
        'ce-type': 'zotregistry.image.updated',
      },
      ...(method === 'POST' ? { body: PUSH } : {}),
    }),
  })
}

describe('a push with a token that does not match', () => {
  it('answers 401 and deploys nothing', async () => {
    // A missing header, a wrong token, and — because the comparison must be on
    // the whole string — a correct prefix and a correct token with one
    // character more.
    for (const token of [undefined, '', 'wrong', TOKEN.slice(0, -1), `${TOKEN}x`]) {
      const res = await call('POST', token)
      expect(res.status, String(token)).toBe(401)
      expect(await res.json()).toEqual({ status: 'error', error: 'bad or missing token' })
    }
    expect(h.deploys).toEqual([])
  })

  it('answers 401 on the status door too, without reading the status', async () => {
    const res = await call('GET', 'wrong')
    expect(res.status).toBe(401)
    expect(h.statusReads).toBe(0)
  })
})

describe('a push arriving with no token configured', () => {
  // Fail closed. An unset DEPLOY_HOOK_TOKEN is a broken deployment, and the
  // one thing it must not become is an endpoint that compares nothing and
  // lets everyone through.
  it('answers 503 and deploys nothing, whatever the caller sends', async () => {
    delete process.env.DEPLOY_HOOK_TOKEN
    for (const token of [undefined, '', TOKEN]) {
      const res = await call('POST', token)
      expect(res.status, String(token)).toBe(503)
      expect(await res.json()).toEqual({
        status: 'error',
        error: 'deploy hook is not configured',
      })
    }
    expect(h.deploys).toEqual([])
  })

  it('answers 503 for an empty token as well as a missing one', async () => {
    // `!expected` and not `expected === undefined`: an env var set to the
    // empty string is a token nobody can hold, and safeEqual('','') is true.
    process.env.DEPLOY_HOOK_TOKEN = ''
    const res = await call('POST', '')
    expect(res.status).toBe(503)
    expect(h.deploys).toEqual([])
  })
})

describe('a push carrying the token', () => {
  // The control. Without it the three tests above would pass just as well
  // against a handler that never deploys at all.
  it('deploys exactly once', async () => {
    const res = await call('POST', TOKEN)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'queued', id: 'deploy-id', app: 'anansi' })
    expect(h.deploys).toEqual([
      { app: 'anansi', reason: 'zotregistry.image.updated', actor: 'registry' },
    ])
  })
})
