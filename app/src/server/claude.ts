import { createServerFn } from '@tanstack/react-start'
import { actorLabel } from '../core/auth'

// The Claude page's one loader.
//
// Thin on purpose, like its siblings here: the work is in
// lib/dashboard/claude.ts, and this exists so the browser bundle never gets
// near the snapshot reader (node:fs) or the Loki client.
//
// One function rather than the boards/dots pair the category pages use. That
// split buys a tab row that renders before its slowest upstream; this page
// has no tabs, and its three sources are a file read, one anchored LogQL
// query and a cached GitHub list — all of which the streaming skeleton
// already covers.

export const fetchClaude = createServerFn().handler(async () => {
  const { loadClaude } = await import('../lib/dashboard/claude')
  return loadClaude()
})

/**
 * Ask the host to restart the Remote Control server.
 *
 * Returns as soon as the request file is written; the caller polls the
 * status for its own id. Terminal states are real here (host/claude-rc.sh
 * outlives its action), so no healthz dance — done or failed arrives within
 * ~ten seconds.
 */
export const requestClaudeRestartFn = createServerFn({ method: 'POST' }).handler(async () => {
  const { assertAdmin } = await import('../core/authz')
  await assertAdmin()
  const { requestClaudeRcRestart } = await import('../host/claude-rc-request')
  // The forward-auth middleware forwards the Pocket ID claim, so the request
  // records a person rather than "daedalus".
  const actor = actorLabel()
  return { id: await requestClaudeRcRestart({ actor }) }
})

export const fetchClaudeRcStatusFn = createServerFn().handler(async () => {
  const { readClaudeRcStatus } = await import('../host/claude-rc-request')
  return readClaudeRcStatus()
})

/**
 * The selector for a per-session action.
 *
 * A real check, not a type annotation: this is the one field of the one verb
 * on this box that causes root to start a shell as the operator. The host
 * agent validates it again and enumerates the transcript tree to decide
 * whether anything answers to it — this is the first door, and the one that
 * keeps a malformed value from being written into the bridge at all.
 */
function sessionSelector(data: unknown): { session: string } {
  if (typeof data !== 'object' || data === null || !('session' in data)) {
    throw new Error('expected a session')
  }
  const { session } = data as { session: unknown }
  if (typeof session !== 'string') throw new Error('expected a session')
  return { session }
}

/**
 * Resume one session — `claude --resume <uuid>`, an argv fixed in nix, under
 * `claude-session@<uuid>.service`.
 *
 * Resume CONTINUES the session it names: same id, same transcript, appended
 * to. Branching is the opt-in (`--fork-session`) and nothing here passes it.
 *
 * Returns as soon as the request file is written; the caller polls the status
 * for its own id. Terminal states are real here — the host agent outlives its
 * action and settles the unit before reporting — so done or failed arrives
 * within about ten seconds.
 */
export const resumeSessionFn = createServerFn({ method: 'POST' })
  .validator(sessionSelector)
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { requestClaudeSessionResume } = await import('../host/claude-session-request')
    // The forward-auth middleware forwards the Pocket ID claim, so the request
    // and the journal record a person rather than "daedalus".
    const actor = actorLabel()
    return { id: await requestClaudeSessionResume({ actor, session: data.session }) }
  })

/**
 * End one session. The selector's shape says which verb the host uses: a uuid
 * is a session this box started (`systemctl stop`, which SIGTERMs the unit's
 * cgroup), an eight-digit id is a background agent (`claude stop`, which keeps
 * the conversation for `claude attach`).
 */
export const stopSessionFn = createServerFn({ method: 'POST' })
  .validator(sessionSelector)
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { requestClaudeSessionStop } = await import('../host/claude-session-request')
    const actor = actorLabel()
    return { id: await requestClaudeSessionStop({ actor, session: data.session }) }
  })

/**
 * Delete a dormant background agent's record — `claude rm <short id>`.
 *
 * The verb for a row with no process behind it, where Stop has no object:
 * `claude stop` on a record whose process died weeks ago cannot succeed, and
 * offering it is what put a red failure on the board for an agent that had
 * never moved. This one is the destructive half of the pair — `stop` keeps the
 * conversation for `claude attach`, `rm` takes the record and its worktree —
 * so the host refuses anything but an eight-digit id the CLI actually reports.
 */
export const removeSessionFn = createServerFn({ method: 'POST' })
  .validator(sessionSelector)
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { requestClaudeSessionRemove } = await import('../host/claude-session-request')
    const actor = actorLabel()
    return { id: await requestClaudeSessionRemove({ actor, session: data.session }) }
  })

export const fetchClaudeSessionStatusFn = createServerFn().handler(async () => {
  const { readClaudeSessionStatus } = await import('../host/claude-session-request')
  return readClaudeSessionStatus()
})

/**
 * The machines the picker offers beside this box: every approved node. One
 * table read, so awaited by the loader; the picker is part of the frame.
 */
export const fetchClaudeNodesFn = createServerFn().handler(async () => {
  const { listNodes } = await import('../lib/repo/nodes')
  return (await listNodes()).filter((n) => n.state === 'approved')
})

const NODE_ID = /^[0-9a-f]{16}$/

/** The Claude page for one node: its row and its live status page. */
export const fetchNodeClaudeFn = createServerFn()
  .validator((data: unknown): { id: string } => {
    const id = (data as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !NODE_ID.test(id)) throw new Error('expected a node id')
    return { id }
  })
  .handler(async ({ data }) => {
    const { loadNodeClaude } = await import('../lib/dashboard/node-claude')
    return loadNodeClaude(data.id)
  })
