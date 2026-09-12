import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// `null` is valid JSON.
//
// Both of these routes used to take `(await request.json()) as Record<…>`,
// which parses `null` without throwing: the catch that answers 400 never ran,
// and the first property read blew up OUTSIDE the try as a 500. A body guard
// is the fix, and these are the requests that proved it — driven through the
// real handler, so the status codes below are the ones a caller sees.

type Handler = (ctx: { request: Request }) => Promise<Response>
type RouteLike = { options?: { server?: { handlers?: { POST?: Handler } } } }

const DEPLOY_TOKEN = 'test-deploy-token'
let savedToken: string | undefined

beforeAll(() => {
  savedToken = process.env.DEPLOY_HOOK_TOKEN
  process.env.DEPLOY_HOOK_TOKEN = DEPLOY_TOKEN
})
afterAll(() => {
  if (savedToken === undefined) delete process.env.DEPLOY_HOOK_TOKEN
  else process.env.DEPLOY_HOOK_TOKEN = savedToken
})

async function post(route: RouteLike, url: string, body: string, extra: HeadersInit = {}) {
  const handler = route.options?.server?.handlers?.POST
  if (!handler) throw new Error(`${url} has no POST handler`)
  return handler({
    request: new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extra },
      body,
    }),
  })
}

describe('/api/image-update refuses a body it cannot read', () => {
  it('answers 400 for null, a list and a bare string', async () => {
    const { Route } = (await import('./api.image-update')) as { Route: RouteLike }
    for (const body of ['null', '[]', '"anansi"', '3']) {
      const res = await post(Route, 'http://x/api/image-update', body)
      expect(res.status, body).toBe(400)
      expect(await res.json()).toEqual({
        status: 'refused',
        reason: 'body must be a JSON object',
      })
    }
  })

  it('still answers 400 for a body that is not JSON at all', async () => {
    const { Route } = (await import('./api.image-update')) as { Route: RouteLike }
    const res = await post(Route, 'http://x/api/image-update', 'not json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ status: 'refused', reason: 'body is not JSON' })
  })
})

describe('/api/deploy refuses a body it cannot read', () => {
  it('answers 400 for null rather than throwing past the catch', async () => {
    const { Route } = (await import('./api.deploy')) as { Route: RouteLike }
    const res = await post(Route, 'http://x/api/deploy', 'null', {
      'x-deploy-token': DEPLOY_TOKEN,
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ status: 'error', error: 'body must be a JSON object' })
  })

  it('checks the token before the body', async () => {
    const { Route } = (await import('./api.deploy')) as { Route: RouteLike }
    const res = await post(Route, 'http://x/api/deploy', 'null')
    expect(res.status).toBe(401)
  })
})
