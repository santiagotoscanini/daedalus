import { createFileRoute } from '@tanstack/react-router'
import { readJsonObject } from '../lib/http-result'

// "I am a machine on your network running the agent."
//
// The agent POSTs here every minute: a signed envelope (lib/agent/hello.ts)
// saying who it is, and the answer says what the box has decided about it
// — `pending` until an admin approves it on System › Machines, `approved`
// after, `revoked` if the box has turned it away. Nothing else happens on
// this path: no command rides the answer, and a hello from an unknown key
// creates a pending row and nothing more.
//
// OUTSIDE the Pocket ID gate (authBypassRule in the daedalus nix module),
// because a service has no passkey. Its credential is the signature: the
// key the agent generated at install signs every hello, and the box keys
// every row on it. Nothing here is a secret the box hands out, so there is
// nothing to leak — the worst a stranger on the LAN can do with this route
// is create a pending row an admin will look at and forget.
//
// Rate: one request a minute per machine, so no limiter; a misbehaving
// agent shows up as a row whose lastSeenAt moves too fast.

export const Route = createFileRoute('/api/nodes/hello')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const read = await readJsonObject(request)
        if (!read.ok) {
          return Response.json({ error: 'body must be a JSON object' }, { status: 400 })
        }
        const { verifyHello } = await import('../lib/agent/hello')
        const verdict = verifyHello(read.value)
        if (!verdict.ok) {
          return Response.json({ error: verdict.reason }, { status: 401 })
        }
        const { recordHello } = await import('../lib/repo/nodes')
        const state = await recordHello(verdict)
        return Response.json({
          node: verdict.nodeId,
          state,
          // The box's clock, so an agent whose clock drifts can see why it
          // was refused before it is.
          server_time: Math.floor(Date.now() / 1000),
        })
      },
    },
  },
})
