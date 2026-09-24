import { createFileRoute } from '@tanstack/react-router'
import { readJsonObject } from '../lib/http-result'

// "I am a machine on your network running the agent."
//
// The agent POSTs here every minute: a signed envelope (host/agent-hello.ts)
// saying who it is, and the answer says what the box has decided about it
// — `pending` until an admin approves it on System › Machines, `approved`
// after, `revoked` if the box has turned it away. For an approved node the
// answer also carries the policy Settings › Machines set (hold it awake,
// run Claude remote control) and up to two one-shot instructions (check
// for updates, restart Claude). A hello from an unknown key creates a
// pending row and nothing more.
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
        const { verifyHello } = await import('../host/agent-hello')
        const verdict = verifyHello(read.value)
        if (!verdict.ok) {
          return Response.json({ error: verdict.reason }, { status: 401 })
        }
        const { recordHello } = await import('../lib/repo/nodes')
        const answer = await recordHello(verdict)
        return Response.json({
          node: verdict.nodeId,
          state: answer.state,
          // The instructions: the agent's updater looks now instead of on
          // its next tick; the tray updates Claude Code, which interrupts
          // nothing; the tray restarts `claude remote-control`, which ends
          // every session on the machine.
          check_update: answer.checkUpdate,
          update_claude: answer.updateClaude,
          restart_claude: answer.restartClaude,
          // The policy, in the agent's vocabulary (agent/src/hello.rs
          // `Policy`); absent until the node is approved.
          ...(answer.policy === null
            ? {}
            : {
                policy: {
                  awake_hold: answer.policy.awakeHold,
                  claude_remote_control: answer.policy.claudeRemoteControl,
                  ...(answer.policy.claudeWorkdir === null
                    ? {}
                    : { claude_workdir: answer.policy.claudeWorkdir }),
                  // Where each provider listens, so the agent's presence probe
                  // asks the right port (agent 0.11.0+; older agents ignore it).
                  providers: { lemonade: { port: answer.policy.providers.lemonade.port } },
                },
              }),
          // The node token: the box's credential for the agent's full Claude
          // report. Only for an approved node, only over this HTTPS answer.
          ...(answer.nodeToken === null ? {} : { node_token: answer.nodeToken }),
          // The box's clock, so an agent whose clock drifts can see why it
          // was refused before it is.
          server_time: Math.floor(Date.now() / 1000),
        })
      },
    },
  },
})
