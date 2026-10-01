import { describe, expect, it } from 'vitest'

// The redeem door is outside the Pocket ID gate, so its body cap is the only
// thing between a LAN caller and this process's memory. Driven through the
// real handler: the status a caller sees is the assertion.

type Handler = (ctx: { request: Request }) => Promise<Response>
type RouteLike = { options?: { server?: { handlers?: { POST?: Handler } } } }

async function post(body: BodyInit) {
  const { Route } = (await import('./api.agent.enroll')) as { Route: RouteLike }
  const handler = Route.options?.server?.handlers?.POST
  if (!handler) throw new Error('/api/agent/enroll has no POST handler')
  // A streamed body needs `duplex`, which Node takes and the DOM typings do not name.
  return handler({
    request: new Request('http://x/api/agent/enroll', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit),
  })
}

describe('/api/agent/enroll caps its body in bytes', () => {
  it('answers 413 for a body over 4096 bytes that is under 4096 characters', async () => {
    const res = await post(JSON.stringify({ code: 'é'.repeat(3000) }))
    expect(res.status).toBe(413)
  })

  it('answers 413 for a streamed body with no length', async () => {
    let sent = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1
        controller.enqueue(new Uint8Array(1024).fill(0x20))
      },
    })
    const res = await post(stream)
    expect(res.status).toBe(413)
    expect(sent).toBeLessThan(10)
  })

  it('reads a small body and refuses what is not JSON', async () => {
    const res = await post('not json')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'the body is not JSON' })
  })
})
