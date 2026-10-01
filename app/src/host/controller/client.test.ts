import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type ControllerClient, createControllerClient } from './client'
import type { ApiEvent } from './generated'
import { ControllerError } from './wire'

// The client against a fake controller on a real unix socket: the framing,
// the hello, id matching, the error codes, the timeout and the reconnect are
// what the socket does, so they are tested over one.

// The agent's own answers (agent/src/api/wire.rs `fixtures`).
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./generated/fixtures/${name}.json`, import.meta.url), 'utf8'))
const HELLO = fixture('hello')
const INFO = fixture('system.info')

type Req = { id: number; m: string; p?: unknown }
/** What the fake does with one request: a line to write back, or nothing. */
type Handler = (req: Req, sock: Socket) => string | null

let dir = ''
let path = ''
let server: Server | null = null
let sockets: Socket[] = []
let seen: Req[] = []
let connections = 0
let clients: ControllerClient[] = []

const answer = (id: number, ok: unknown) => `${JSON.stringify({ id, ok })}\n`
const fail = (id: number | null, code: string, msg: string, extra: object = {}) =>
  `${JSON.stringify({ id, err: { code, msg, ...extra } })}\n`

/** The agent's behaviour, enough of it: hello first, then `handler`. */
const agent =
  (handler: Handler = () => null): Handler =>
  (req, sock) => {
    if (req.m === 'hello') return answer(req.id, HELLO)
    if (req.m === 'system.info') return answer(req.id, INFO)
    return handler(req, sock)
  }

function serve(handler: Handler, onConnect?: (sock: Socket) => void): Promise<void> {
  server = createServer((sock) => {
    connections += 1
    sockets.push(sock)
    if (onConnect !== undefined) {
      onConnect(sock)
      if (sock.destroyed) return
    }
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const req = JSON.parse(buf.slice(0, nl)) as Req
        buf = buf.slice(nl + 1)
        seen.push(req)
        const out = handler(req, sock)
        if (out !== null) sock.write(out)
      }
    })
    sock.on('error', () => {})
  })
  const s = server
  return new Promise((resolve) => s.listen(path, resolve))
}

function stop(): Promise<void> {
  for (const s of sockets) s.destroy()
  sockets = []
  const s = server
  server = null
  return new Promise((resolve) => (s === null ? resolve() : s.close(() => resolve())))
}

function client(
  opts: {
    timeoutMs?: number
    backoffMs?: number
    onConnect?: (c: ControllerClient) => void
    onEvent?: (e: ApiEvent) => void
  } = {},
): ControllerClient {
  const c = createControllerClient({ path, client: 'daedalus/test', ...opts })
  clients.push(c)
  return c
}

async function rejection(p: Promise<unknown>): Promise<ControllerError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ControllerError) return e
    throw e
  }
  throw new Error('expected a rejection')
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'controller-'))
  path = join(dir, 'api.sock')
  seen = []
  connections = 0
})

afterEach(async () => {
  for (const c of clients) c.close()
  clients = []
  await stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('the controller client', () => {
  it('says hello first, with the api version and its name, then asks', async () => {
    await serve(agent())
    const c = client()
    const info = await c.call('system.info')
    expect(seen.map((r) => r.m)).toEqual(['hello', 'system.info'])
    expect(seen[0]?.p).toEqual({ api: 1, client: 'daedalus/test' })
    expect(seen[1]?.p).toBeUndefined()
    expect(info.version).toBe('0.13.0')
    expect(info.role.api_socket).toBe(true)
    expect(c.hello()?.capabilities).toEqual(['claude.remote_control', 'telemetry.full'])
  })

  it('keeps one connection for many calls, and matches answers that come back out of order', async () => {
    const held: Req[] = []
    await serve(
      agent((req, sock) => {
        if (req.m !== 'claude.status') return null
        held.push(req)
        // Answer the pair in reverse once both are in.
        if (held.length === 2) {
          for (const r of [...held].reverse()) {
            sock.write(answer(r.id, { reporting: false, wanted: r === held[0], report: null }))
          }
        }
        return null
      }),
    )
    const c = client()
    const [a, b] = await Promise.all([c.call('claude.status'), c.call('claude.status')])
    expect(a.wanted).toBe(true)
    expect(b.wanted).toBe(false)
    await c.call('system.info')
    expect(connections).toBe(1)
    expect(seen.filter((r) => r.m === 'hello')).toHaveLength(1)
  })

  it('hands the agent’s error codes back typed', async () => {
    await serve(
      agent((req) => {
        if (req.m === 'claude.restart') {
          return fail(req.id, 'unavailable', 'Claude remote control is off on this machine')
        }
        if (req.m === 'telemetry.get') return fail(req.id, 'unsupported', 'no')
        return null
      }),
    )
    const c = client()
    const e = await rejection(c.call('claude.restart'))
    expect(e.code).toBe('unavailable')
    expect(e.message).toMatch(/off on this machine/)
    expect((await rejection(c.call('telemetry.get'))).code).toBe('unsupported')
    // An error answer is not a broken connection.
    expect((await c.call('system.info')).api).toBe(1)
    expect(connections).toBe(1)
  })

  it('times a call out, and ignores its answer when it comes late', async () => {
    let late: (() => void) | null = null
    await serve(
      agent((req, sock) => {
        if (req.m === 'claude.status') {
          late = () => sock.write(answer(req.id, { reporting: false, wanted: false, report: null }))
        }
        return null
      }),
    )
    const c = client({ timeoutMs: 150 })
    const e = await rejection(c.call('claude.status'))
    expect(e.code).toBe('timeout')
    ;(late as (() => void) | null)?.()
    await tick(20)
    expect((await c.call('system.info')).api).toBe(1)
  })

  it('waits out a machine’s acknowledgement on the calls the controller relays', async () => {
    // The fake answers everything a little past the client's own timeout — as
    // a controller does while it waits on a machine's ack.
    const slow = (req: Req, sock: Socket) => {
      const ok =
        req.m === 'nodes.command'
          ? { delivered: true, queued: false }
          : req.m === 'claude.status'
            ? { reporting: false, wanted: false, report: null }
            : { delivered: true, request: 'r-1' }
      setTimeout(() => sock.write(answer(req.id, ok)), 300)
      return null
    }
    await serve(agent(slow))
    const c = client({ timeoutMs: 150 })
    const node = '0123456789abcdef'
    expect(await c.call('nodes.command', { id: node, command: 'check_update' })).toEqual({
      delivered: true,
      queued: false,
    })
    expect(
      await c.call('nodes.claude_session', { id: node, action: 'resume', session: 's-1' }),
    ).toEqual({ delivered: true, request: 'r-1' })
    expect(
      await c.call('nodes.provider_model', {
        id: node,
        kind: 'lemonade',
        action: 'load',
        model: 'm',
      }),
    ).toEqual({ delivered: true, request: 'r-1' })
    // A call the controller answers itself keeps the short timeout.
    expect((await rejection(c.call('claude.status'))).code).toBe('timeout')
  })

  it('dials again after the controller closes the connection', async () => {
    await serve(agent())
    const c = client()
    await c.call('system.info')
    for (const s of sockets) s.destroy()
    await tick(30)
    expect(c.hello()).toBeNull()
    expect((await c.call('system.info')).api).toBe(1)
    expect(connections).toBe(2)
  })

  it('fails the calls in flight when the connection drops under them', async () => {
    await serve(
      agent((_req, sock) => {
        sock.destroy()
        return null
      }),
    )
    const c = client()
    await c.call('system.info')
    expect((await rejection(c.call('claude.status'))).code).toBe('closed')
  })

  it('says unreachable when there is no socket, and backs off before dialling again', async () => {
    const c = client({ backoffMs: 200 })
    const first = await rejection(c.call('system.info'))
    expect(first.code).toBe('unreachable')
    expect(first.message).toMatch(/no socket at .*api\.sock/)
    await serve(agent())
    // Inside the backoff: answered from the last failure, no dial.
    expect((await rejection(c.call('system.info'))).code).toBe('unreachable')
    expect(connections).toBe(0)
    await tick(250)
    expect((await c.call('system.info')).api).toBe(1)
    expect(connections).toBe(1)
  })

  it('reports a version mismatch with the version the agent speaks', async () => {
    await serve((req) =>
      req.m === 'hello'
        ? fail(req.id, 'version', 'this agent speaks api 2, not 1', { supported: 2 })
        : null,
    )
    const e = await rejection(client().call('system.info'))
    expect(e.code).toBe('version')
    expect(e.supported).toBe(2)
  })

  it('takes the agent’s refusal of the connection as the reason', async () => {
    await serve(
      () => null,
      (sock) => {
        sock.end(fail(null, 'forbidden', 'uid 100999 may not use this socket'))
      },
    )
    const e = await rejection(client().call('system.info'))
    expect(e.code).toBe('forbidden')
  })

  it('drops a line longer than the agent’s cap', async () => {
    await serve(
      agent((req, sock) => {
        if (req.m === 'telemetry.get')
          sock.write(`{"id":${req.id},"ok":"${'x'.repeat(1 << 20)}"}\n`)
        return null
      }),
    )
    const c = client()
    await c.call('system.info')
    expect((await rejection(c.call('telemetry.get'))).code).toBe('too_large')
    // And the next call starts over on a new connection.
    expect((await c.call('system.info')).api).toBe(1)
    expect(connections).toBe(2)
  })

  it('reads a line that arrives in pieces', async () => {
    await serve(
      agent((req, sock) => {
        if (req.m !== 'claude.restart') return null
        const line = answer(req.id, { queued: true })
        sock.write(line.slice(0, 5))
        setTimeout(() => sock.write(line.slice(5)), 20)
        return null
      }),
    )
    expect(await client().call('claude.restart')).toEqual({ queued: true })
  })

  it('refuses every call once closed, and never dials for them', async () => {
    await serve(agent())
    const c = client()
    await c.call('system.info')
    c.close()
    expect((await rejection(c.call('system.info'))).code).toBe('closed')
    expect(connections).toBe(1)
  })

  it('answers not_configured when the box binds no socket', async () => {
    const c = createControllerClient({ path: undefined, client: 'daedalus/test' })
    expect((await rejection(c.call('system.info'))).code).toBe('not_configured')
  })

  it('asks the nodes methods with their selectors, and decodes the answers', async () => {
    await serve(
      agent((req) => {
        switch (req.m) {
          case 'nodes.list':
            return answer(req.id, { nodes: [] })
          case 'nodes.set_desired':
            return answer(req.id, { nodes: 1, approved: [], revoked: [], pending: [], policy: [] })
          case 'nodes.command':
            return answer(req.id, { delivered: false, queued: true })
          case 'nodes.telemetry':
            return answer(req.id, { id: '0123456789abcdef', telemetry: null, received_at: null })
          default:
            return fail(req.id, 'not_found', 'no machine')
        }
      }),
    )
    const c = client()
    expect(await c.call('nodes.list')).toEqual({ nodes: [] })
    const set = [
      {
        id: '0123456789abcdef',
        public_key: 'ab'.repeat(32),
        state: 'revoked' as const,
      },
    ]
    expect((await c.call('nodes.set_desired', { nodes: set })).nodes).toBe(1)
    // Only ever against this fake: a command never reaches a real controller in a test.
    expect(
      await c.call('nodes.command', { id: '0123456789abcdef', command: 'check_update' }),
    ).toEqual({
      delivered: false,
      queued: true,
    })
    expect((await c.call('nodes.telemetry', { id: '0123456789abcdef' })).telemetry).toBeNull()
    expect((await rejection(c.call('nodes.get', { id: '0123456789abcdef' }))).code).toBe(
      'not_found',
    )
    expect(seen.slice(1).map((r) => [r.m, r.p])).toEqual([
      ['nodes.list', undefined],
      ['nodes.set_desired', { nodes: set }],
      ['nodes.command', { id: '0123456789abcdef', command: 'check_update' }],
      ['nodes.telemetry', { id: '0123456789abcdef' }],
      ['nodes.get', { id: '0123456789abcdef' }],
    ])
  })

  it('calls onConnect after every hello, the first and each re-dial, on that connection', async () => {
    await serve(agent())
    let connects = 0
    const c = client({
      onConnect: (self) => {
        connects += 1
        // The hook's own call rides the connection that just opened.
        void self.call('system.info')
      },
    })
    await c.call('system.info')
    await tick(30)
    expect(connects).toBe(1)
    expect(connections).toBe(1)
    for (const s of sockets) s.destroy()
    await tick(30)
    await c.call('system.info')
    await tick(30)
    expect(connects).toBe(2)
    expect(connections).toBe(2)
  })
})

describe('how the link stands', () => {
  it('is idle before any call, connected after one, and never dials to say so', async () => {
    await serve(agent())
    const c = client()
    expect(c.link()).toEqual({ state: 'idle' })
    expect(connections).toBe(0)
    await c.call('system.info')
    const up = c.link()
    expect(up.state).toBe('connected')
    expect(connections).toBe(1)
  })

  it('is down from the first failure, through every failed re-dial, until one holds', async () => {
    const c = client({ backoffMs: 20 })
    await rejection(c.call('system.info'))
    const first = c.link()
    expect(first.state).toBe('down')
    if (first.state !== 'down') return
    expect(first.error).toMatch(/no socket at/)
    await tick(30)
    await rejection(c.call('system.info'))
    const again = c.link()
    // The same outage: its start does not move with each attempt.
    expect(again.state === 'down' && again.since).toBe(first.since)
    await serve(agent())
    await tick(50)
    await c.call('system.info')
    expect(c.link().state).toBe('connected')
  })

  it('is down when a connection that held drops, with why', async () => {
    await serve(agent())
    const c = client()
    await c.call('system.info')
    for (const s of sockets) s.destroy()
    await tick(30)
    const l = c.link()
    expect(l.state).toBe('down')
    expect(l.state === 'down' && l.error).toMatch(/closed/)
  })

  it('is not_configured when the box binds no socket', () => {
    const c = createControllerClient({ path: undefined, client: 'daedalus/test' })
    expect(c.link()).toEqual({ state: 'not_configured' })
  })
})

describe('the controller’s events', () => {
  it('are subscribed to on each connection and handed over, a bad handler costing nothing', async () => {
    await serve(
      agent((req, sock) => {
        if (req.m !== 'events.subscribe') return null
        sock.write(answer(req.id, {}))
        const left = (id: string) =>
          sock.write(`${JSON.stringify({ e: 'nodes.left', p: { id } })}\n`)
        left('0123456789abcdef')
        // An event this app does not know is not handed over.
        sock.write(`${JSON.stringify({ e: 'telemetry.updated', p: {} })}\n`)
        left('fedcba9876543210')
        return null
      }),
    )
    const got: ApiEvent[] = []
    const c = client({
      onEvent: (e) => {
        got.push(e)
        if (got.length === 1) throw new Error('a handler that fails')
      },
    })
    await c.call('system.info')
    await tick(50)
    // Subscribed as the connection opens, beside the first call.
    expect(seen.map((r) => r.m).sort()).toEqual(['events.subscribe', 'hello', 'system.info'])
    expect(got).toEqual([
      { e: 'nodes.left', p: { id: '0123456789abcdef' } },
      { e: 'nodes.left', p: { id: 'fedcba9876543210' } },
    ])
    // The connection outlived the handler's throw.
    expect((await c.call('system.info')).version).toBe('0.13.0')
  })

  it('keep their connection: one that drops is dialled again and subscribed again, with no call', async () => {
    await serve(agent((req) => (req.m === 'events.subscribe' ? answer(req.id, {}) : null)))
    const c = client({ onEvent: () => undefined })
    await c.call('system.info')
    for (const s of sockets) s.destroy()
    await tick(100)
    expect(connections).toBe(2)
    expect(seen.filter((r) => r.m === 'events.subscribe')).toHaveLength(2)
    expect(c.link().state).toBe('connected')
  })

  it('fail the connection when the controller will not subscribe it', async () => {
    await serve(
      agent((req) => (req.m === 'events.subscribe' ? fail(req.id, 'busy', 'no room') : null)),
    )
    const c = client({ onEvent: () => undefined })
    expect((await rejection(c.call('system.info'))).code).toBe('busy')
    expect(c.link().state).toBe('down')
  })

  it('are not asked for by a client with no handler', async () => {
    await serve(agent())
    await client().call('system.info')
    await tick(20)
    expect(seen.map((r) => r.m)).toEqual(['hello', 'system.info'])
  })
})
