import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MCP_TOOLS } from '../../lib/mcp'

// The door in front of daedalus's tools.
//
// /mcp is one of the paths outside the Pocket ID gate (authBypassRule in
// stacks/daedalus/daedalus.nix), because an agent cannot hold a passkey. It
// carries a scoped token instead — and a write token can start a build, move an
// image pin and press Apply, which is the widest thing any credential on this
// box does. So the gate gets the same treatment api.deploy.test.ts gives its
// sibling, and for the same stated reason:
//
// EVERY ASSERTION HERE IS ABOUT THE SIDE EFFECT, not the status code. A 401
// that still ran the tool would pass a status-only test and would already have
// queued the build by the time the caller read the body.
//
// Three properties, each of which is invisible from the outside when it breaks:
//
//   1. no token, wrong token, revoked token → 401, and NOTHING happened: no
//      server built, no tool run, not even a lastUsedAt write.
//   2. a read token cannot reach a write tool. The refusal is a tool error, and
//      the underlying flow was never called.
//   3. a write tool's actor is the TOKEN'S LABEL, namespaced `mcp:`. A write
//      attributed to "unknown operator" is a write nobody can trace.

const h = vi.hoisted(() => ({
  /** What identifyMcpToken will answer, keyed by the presented token. */
  tokens: new Map<string, { id: string; label: string; scope: 'read' | 'write' }>(),
  stamps: [] as string[],
  builds: [] as { app: string; actor: string }[],
  cancels: [] as { app: string; id: string; actor: string }[],
  healthReads: 0,
}))

vi.mock('./tokens', () => ({
  identifyMcpToken: async (presented: string | null) =>
    presented === null ? null : (h.tokens.get(presented) ?? null),
  stampMcpTokenUse: async (id: string) => {
    h.stamps.push(id)
  },
}))

vi.mock('../../core/builds/actions', () => ({
  buildNow: async (input: { app: string; actor: string }) => {
    h.builds.push(input)
    return { ok: true, value: { id: 'build-1', sha: 'a'.repeat(40), existing: false } }
  },
  cancelBuild: async (input: { app: string; id: string; actor: string }) => {
    h.cancels.push(input)
    return { ok: true, value: null }
  },
}))

vi.mock('../../lib/dashboard/health', () => ({
  loadHealth: async () => {
    h.healthReads++
    return { probes: [{ name: 'daedalus', healthy: true }], failing: [], unavailable: false }
  },
}))

const READ_TOKEN = 'dmcp_read-token-value'
const WRITE_TOKEN = 'dmcp_write-token-value'

beforeEach(() => {
  h.tokens = new Map([
    [READ_TOKEN, { id: 'tok-read', label: 'triage', scope: 'read' as const }],
    [WRITE_TOKEN, { id: 'tok-write', label: 'claude-code', scope: 'write' as const }],
  ])
  h.stamps = []
  h.builds = []
  h.cancels = []
  h.healthReads = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

type RpcBody = {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: Record<string, unknown>
}

async function call(body: RpcBody, token?: string, method = 'POST') {
  const { handleMcpRequest } = await import('./http')
  return handleMcpRequest(
    new Request('http://app-daedalus:3000/mcp', {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }),
  )
}

const INITIALIZE: RpcBody = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'vitest', version: '1' },
  },
}

const callTool = (name: string, args: Record<string, unknown> = {}): RpcBody => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name, arguments: args },
})

/** The one text block a tool answers with, parsed back out of the envelope. */
function toolText(payload: unknown): { text: string; isError: boolean } {
  const result = (payload as { result?: { content?: { text?: string }[]; isError?: boolean } })
    .result
  return { text: result?.content?.[0]?.text ?? '', isError: result?.isError === true }
}

describe('a request with a token that does not match', () => {
  it('answers 401 and does nothing at all', async () => {
    // A missing header, a blank one, a wrong token, and — because the match
    // must be on the whole string — a correct prefix and one character more.
    for (const token of [undefined, '', 'wrong', WRITE_TOKEN.slice(0, -1), `${WRITE_TOKEN}x`]) {
      const res = await call(callTool('build.now', { app: 'anansi' }), token)
      expect(res.status, String(token)).toBe(401)
      expect(await res.json()).toMatchObject({
        error: { code: -32001, message: 'bad or missing MCP token' },
      })
    }
    // The point of the test: not one of those reached a tool, and not one of
    // them even got this endpoint to write a timestamp.
    expect(h.builds).toEqual([])
    expect(h.stamps).toEqual([])
  })

  it('names the scheme, so a client that can authenticate knows how', async () => {
    const res = await call(INITIALIZE)
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="daedalus"')
  })

  it('refuses a revoked token exactly as it refuses an unknown one', async () => {
    // Revocation is `identifyMcpToken` answering null — the same answer an
    // unknown token gets, deliberately, so a caller cannot learn that a token
    // it guessed once existed.
    h.tokens.delete(WRITE_TOKEN)
    const res = await call(callTool('build.now', { app: 'anansi' }), WRITE_TOKEN)
    expect(res.status).toBe(401)
    expect(h.builds).toEqual([])
  })

  it('refuses before reading the body, so a malformed request is still a 401', async () => {
    const { handleMcpRequest } = await import('./http')
    const res = await handleMcpRequest(
      new Request('http://app-daedalus:3000/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json at all',
      }),
    )
    expect(res.status).toBe(401)
    expect(h.stamps).toEqual([])
  })
})

describe('a GET', () => {
  it('is refused: this server is stateless, so there is no stream to open', async () => {
    const res = await call(INITIALIZE, WRITE_TOKEN, 'GET')
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
    expect(h.stamps).toEqual([])
  })
})

describe('the catalogue', () => {
  it('offers every tool in MCP_TOOLS, whatever the token can reach', async () => {
    // Registered for both scopes on purpose: a read token can SEE what a write
    // token would reach, and the refusal happens at the call rather than being
    // hidden inside "unknown tool".
    for (const token of [READ_TOKEN, WRITE_TOKEN]) {
      await call(INITIALIZE, token)
      const res = await call({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, token)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { result: { tools: { name: string }[] } }
      expect(body.result.tools.map((t) => t.name).sort()).toEqual(
        MCP_TOOLS.map((t) => t.name).sort(),
      )
    }
  })

  it('offers both design documents as resources', async () => {
    await call(INITIALIZE, READ_TOKEN)
    const res = await call({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, READ_TOKEN)
    const body = (await res.json()) as { result: { resources: { uri: string }[] } }
    expect(body.result.resources.map((r) => r.uri).sort()).toEqual([
      'daedalus://docs/architecture',
      'daedalus://docs/builds',
    ])
  })
})

describe('a read token', () => {
  it('reaches a read tool', async () => {
    const res = await call(callTool('health'), READ_TOKEN)
    expect(res.status).toBe(200)
    const { text, isError } = toolText(await res.json())
    expect(isError).toBe(false)
    expect(JSON.parse(text)).toMatchObject({ failing: [], unavailable: false })
    expect(h.healthReads).toBe(1)
    // The call was stamped, so an unused token is visible enough to revoke.
    expect(h.stamps).toEqual(['tok-read'])
  })

  it('cannot reach a write tool, and the flow behind it is never called', async () => {
    for (const [name, args] of [
      ['build.now', { app: 'anansi' }],
      ['build.cancel', { app: 'anansi', id: 'build-1' }],
      ['apply', {}],
    ] as const) {
      const res = await call(callTool(name, args), READ_TOKEN)
      // A refusal, not a transport error: the caller asked a real question and
      // gets a real sentence back.
      expect(res.status, name).toBe(200)
      const { text, isError } = toolText(await res.json())
      expect(isError, name).toBe(true)
      expect(text).toContain('read-only')
      expect(text).toContain(name)
    }
    expect(h.builds).toEqual([])
    expect(h.cancels).toEqual([])
  })
})

describe('a write token', () => {
  it("threads the token's LABEL through as the actor, namespaced", async () => {
    const res = await call(callTool('build.now', { app: 'anansi' }), WRITE_TOKEN)
    expect(res.status).toBe(200)
    expect(toolText(await res.json()).isError).toBe(false)
    // Not "unknown operator", and not the bare label either: `mcp:` says which
    // door the write came through, which is what an audit of a build row or a
    // site commit actually wants to know.
    expect(h.builds).toEqual([{ app: 'anansi', actor: 'mcp:claude-code' }])
  })

  it('threads it through cancel too', async () => {
    await call(callTool('build.cancel', { app: 'anansi', id: 'build-1' }), WRITE_TOKEN)
    expect(h.cancels).toEqual([{ app: 'anansi', id: 'build-1', actor: 'mcp:claude-code' }])
  })

  it('still reaches every read tool', async () => {
    const res = await call(callTool('health'), WRITE_TOKEN)
    expect(toolText(await res.json()).isError).toBe(false)
    expect(h.healthReads).toBe(1)
  })
})
