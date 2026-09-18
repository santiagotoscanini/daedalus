import { createFileRoute } from '@tanstack/react-router'

// Daedalus's MCP server, at /mcp.
//
// Streamable HTTP, served by the app itself — no supergateway, no sidecar
// container, no second process to keep alive. The tools ARE the loaders and
// flows this app already runs, so putting the transport anywhere else would
// mean an HTTP hop back into here.
//
// This file is intentionally three lines of substance. Everything it could
// import — the token store, the tool registry, the SDK — needs the machine,
// and this module lives at `src/routes/mcp.ts`, which `host/boundary.test.ts`
// classifies as CLIENT code (the `api.*` exemption is by filename, and the
// URL has to be `/mcp`). The dynamic import is the codebase's own mechanism
// for that: it is not an edge a bundler follows, so nothing here reaches a
// browser.
//
// POST is the whole protocol; GET and DELETE are answered — with a 405 — by
// the same handler, so the refusal is written once. See host/mcp/http.ts for
// the auth posture and why this path is outside the Pocket ID gate.
export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      POST: async ({ request }) => (await import('../host/mcp/http')).handleMcpRequest(request),
      GET: async ({ request }) => (await import('../host/mcp/http')).handleMcpRequest(request),
      DELETE: async ({ request }) => (await import('../host/mcp/http')).handleMcpRequest(request),
    },
  },
})
