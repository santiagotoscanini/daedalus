import { beforeEach, describe, expect, it, vi } from 'vitest'

// The three scriptable doors answer through lib/http-result.ts, and the bodies
// below are the ones they answered before it existed — asserted as TEXT where
// the key order is part of what a caller may have come to depend on. The flows
// are stubbed: what they decide is host/*-flow.test.ts's subject, and what is
// under test here is only the translation of an outcome into a response.

const h = vi.hoisted(() => ({
  apply: {} as unknown,
  update: {} as unknown,
  engine: {} as unknown,
  seen: [] as unknown[],
  // The gate every POST here passes first. Swapped for a refusal in the one
  // test that proves a door calls it BEFORE its flow.
  admin: async (): Promise<string> => 'operator@example.com',
}))

vi.mock('../core/authz', () => ({ assertAdminOf: () => h.admin() }))

vi.mock('../host/apply-flow', () => ({ runApply: async () => h.apply }))
vi.mock('../host/update-flow', () => ({
  runImageUpdate: async (input: unknown) => {
    h.seen.push(input)
    return h.update
  },
}))
vi.mock('../host/engine-flow', () => ({
  runEngineUpdate: async (input: unknown) => {
    h.seen.push(input)
    return h.engine
  },
}))

type Handler = (ctx: { request: Request }) => Promise<Response>
type RouteLike = { options?: { server?: { handlers?: { POST?: Handler } } } }

async function post(
  path: './api.registry.apply' | './api.image-update' | './api.engine-update',
  body?: unknown,
) {
  const { Route } = (await import(path)) as { Route: RouteLike }
  const handler = Route.options?.server?.handlers?.POST
  if (!handler) throw new Error(`${path} has no POST handler`)
  return handler({
    request: new Request('http://x/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  })
}

beforeEach(() => {
  h.seen = []
  h.admin = async () => 'operator@example.com'
})

describe('POST /api/registry/apply', () => {
  it('answers 200 queued with the id and what changed', async () => {
    h.apply = { ok: true, id: 'abc', changed: [{ name: 'iris', fields: ['image'] }] }
    const res = await post('./api.registry.apply')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(
      '{"status":"queued","id":"abc","changed":[{"name":"iris","fields":["image"]}]}',
    )
  })

  it('answers 409 with the code as the status for every refusal', async () => {
    for (const code of ['busy', 'noop', 'pending']) {
      h.apply = { ok: false, code, reason: `because ${code}` }
      const res = await post('./api.registry.apply')
      expect(res.status, code).toBe(409)
      expect(await res.text()).toBe(`{"status":"${code}","reason":"because ${code}"}`)
    }
  })
})

describe('POST /api/image-update', () => {
  it('keeps the pre-batch fields for a one-container request', async () => {
    h.update = { ok: true, id: 'abc', targets: [{ container: 'iris', toTag: null }] }
    const res = await post('./api.image-update', { container: 'iris' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(
      '{"status":"queued","id":"abc","targets":[{"container":"iris","toTag":null}],"container":"iris","toTag":null}',
    )
    expect(h.seen).toEqual([{ targets: [{ container: 'iris' }], actor: 'api' }])
  })

  it('omits them for a batch', async () => {
    const targets = [
      { container: 'iris', toTag: 'v2' },
      { container: 'anansi', toTag: null },
    ]
    h.update = { ok: true, id: 'abc', targets }
    const res = await post('./api.image-update', {
      targets: [{ container: 'iris', toTag: 'v2' }, { container: 'anansi' }],
    })
    expect(await res.json()).toEqual({ status: 'queued', id: 'abc', targets })
  })

  it('answers 409 for the flow’s refusals, `refused` included', async () => {
    for (const code of ['busy', 'refused']) {
      h.update = { ok: false, code, reason: `because ${code}` }
      const res = await post('./api.image-update', { container: 'iris' })
      expect(res.status, code).toBe(409)
      expect(await res.json()).toEqual({ status: code, reason: `because ${code}` })
    }
  })

  it('answers 400 for a body the flow never sees', async () => {
    for (const [body, reason] of [
      [{ targets: 'iris' }, 'targets must be an array when present'],
      [{ container: 3 }, 'container must be a string'],
      [{ container: 'iris', toTag: 3 }, 'toTag must be a string when present'],
    ] as const) {
      const res = await post('./api.image-update', body)
      expect(res.status, reason).toBe(400)
      expect(await res.json()).toEqual({ status: 'refused', reason })
    }
    expect(h.seen).toEqual([])
  })
})

describe('POST /api/engine-update', () => {
  it('answers 200 queued with the id, and passes the door’s actor to the flow', async () => {
    h.engine = { ok: true, id: 'abc' }
    const res = await post('./api.engine-update')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('{"status":"queued","id":"abc"}')
    expect(h.seen).toEqual([{ actor: 'api' }])
  })

  it('answers 409 for the flow’s refusals, `refused` included', async () => {
    for (const code of ['busy', 'refused']) {
      h.engine = { ok: false, code, reason: `because ${code}` }
      const res = await post('./api.engine-update')
      expect(res.status, code).toBe(409)
      expect(await res.json()).toEqual({ status: code, reason: `because ${code}` })
    }
  })

  it('asks the admin gate before the flow, and publishes nothing when it refuses', async () => {
    // The mutation's authorization, asserted where the mutation is: a door
    // that reached the flow first would have moved the lock for anyone who
    // could reach the LAN.
    h.admin = async () => {
      throw new Error('not an admin')
    }
    h.engine = { ok: true, id: 'never' }
    await expect(post('./api.engine-update')).rejects.toThrow(/not an admin/)
    expect(h.seen).toEqual([])
  })
})
