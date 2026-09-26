import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { identifyMcpToken, type McpIdentity, stampMcpTokenUse } from './tokens'

// The door: HTTP in, MCP out.
//
// ── the posture, and why it is the same one /api/deploy has ───────────────
//
// /mcp is in daedalus's `authBypassRule` (nix/stacks/daedalus/daedalus.nix), so a
// request arrives here WITHOUT passing Pocket ID — an agent cannot hold a
// passkey any more than zot can. Three things make that acceptable, and all
// three have to stay true:
//
//   1. The endpoint is LAN-only. daedalus is `stage = "lab"`: no Cloudflare
//      tunnel route, no public CNAME. The only callers are on this network.
//   2. `isolated = true` puts the container on a private bridge whose only
//      other member is traefik, so nothing on traefik-net can dial it past
//      the gate. (It also sits on app-db and monitoring for its own reads;
//      those bridges' members are the only other containers that can reach it.)
//   3. THIS FILE. A scoped token, hashed, compared in constant time, checked
//      BEFORE any work — no body parse, no database read beyond the token
//      lookup, no tool registration. Fail-closed: no token, unknown token,
//      revoked token and malformed header all answer 401 and do nothing.
//
// The token IS the authentication on this path, exactly as X-Deploy-Token is
// on /api/deploy. It is also the AUTHORIZATION for the writes, which is why
// core/authz.ts has one named function for a machine caller
// (`assertMachineActor`, called from server.ts) rather than a flag on the
// human gate.
//
// ── stateless ─────────────────────────────────────────────────────────────
//
// A fresh transport and a fresh server per request, `sessionIdGenerator:
// undefined`. No session table, nothing to leak between callers, and no
// resumption story to get wrong; the caller's scope is closed over by that
// one request's handlers and cannot outlive it. POST only — a stateless
// server has no server-initiated notifications to stream, so GET and DELETE
// answer 405, which the Streamable HTTP spec provides for.

const BEARER = /^Bearer\s+(.+)$/i

/** What the caller proved, or the response to send instead. */
type Gate = { ok: true; identity: McpIdentity } | { ok: false; response: Response }

const jsonRpcError = (status: number, code: number, message: string): Response =>
  new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }), {
    status,
    headers: {
      'content-type': 'application/json',
      // Tells a client that DOES know how to authenticate which scheme to use.
      ...(status === 401 ? { 'www-authenticate': 'Bearer realm="daedalus"' } : {}),
    },
  })

/**
 * Who is calling, from `Authorization: Bearer <token>` and nothing else.
 *
 * One header, one scheme. A query parameter would put the credential in every
 * proxy log on the path, and a second accepted header would be a second thing
 * to get wrong.
 */
async function authenticate(request: Request): Promise<Gate> {
  const header = request.headers.get('authorization') ?? ''
  const token = BEARER.exec(header)?.[1] ?? null

  const identity = await identifyMcpToken(token)
  if (identity === null) {
    // Deliberately one sentence for every failure. Saying WHICH failure it was
    // tells a caller whether a guessed token exists.
    return { ok: false, response: jsonRpcError(401, -32001, 'bad or missing MCP token') }
  }
  return { ok: true, identity }
}

/** Handle one MCP request. Exported for the route and for its test. */
export async function handleMcpRequest(request: Request): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32000, message: 'this MCP server is stateless: POST only' },
      }),
      { status: 405, headers: { 'content-type': 'application/json', allow: 'POST' } },
    )
  }

  const gate = await authenticate(request)
  if (!gate.ok) return gate.response

  // After the gate, never before: a stamp is a write, and an unauthenticated
  // caller must not be able to make this endpoint write anything at all. Not
  // awaited — the timestamp is an audit convenience and must not add a round
  // trip to every tool call, nor fail one.
  void stampMcpTokenUse(gate.identity.id)

  const { buildMcpServer } = await import('./server')
  const server = buildMcpServer(gate.identity)
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no session id, no session validation, nothing held between
    // requests.
    sessionIdGenerator: undefined,
    // Answer with a plain JSON body rather than opening an SSE stream. Nothing
    // here is long-running from the transport's point of view — a write tool
    // returns as soon as the bridge request is published, and the host's
    // progress is read back by a later read-tool call (builds.get,
    // deployments, apply.preview's `blocked`), not by streaming.
    enableJsonResponse: true,
  })

  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    // The JSON response is fully buffered by the time handleRequest resolves
    // (enableJsonResponse), so closing here cannot truncate it — and leaving
    // one open per request would leak a server object per call.
    await server.close().catch(() => undefined)
  }
}
