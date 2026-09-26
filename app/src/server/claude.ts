import { asValidator, obj, str, withMessage } from '../lib/contract/decode'
import { nodeIdField } from '../lib/contract/fields-d'
import { adminFn, readFn } from './fn'

// The Claude tab's loaders — the box's (System › Claude and Shotter, through
// modules/system/data/claude.ts) and a node's.
//
// Thin on purpose, like its siblings here: the work is in
// lib/dashboard/claude.ts, and this exists so the browser bundle never gets
// near the snapshot reader (node:fs) or the Loki client.
// The box's own document is loaded by the module loader (fetchModuleBoards)
// like every other System tab; what stays here is the node's report and the
// session actions.

/**
 * Ask the host to restart the Remote Control server.
 *
 * Returns as soon as the request file is written; the caller polls the
 * status for its own id. Terminal states are real here (host/claude-rc.sh
 * outlives its action), so no healthz dance — done or failed arrives within
 * ~ten seconds.
 */
export const requestClaudeRestartFn = adminFn.handler(async ({ context }) => {
  const { requestClaudeRcRestart } = await import('../host/claude-rc-request')
  // The forward-auth middleware forwards the Pocket ID claim, so the request
  // records a person rather than "daedalus".
  const actor = context.actor()
  return { id: await requestClaudeRcRestart({ actor }) }
})

export const fetchClaudeRcStatusFn = readFn.handler(async () => {
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
const sessionSelector = asValidator(withMessage(obj({ session: str }), 'expected a session'))

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
export const resumeSessionFn = adminFn
  .validator(sessionSelector)
  .handler(async ({ data, context }) => {
    const { requestClaudeSessionResume } = await import('../host/claude-session-request')
    // The forward-auth middleware forwards the Pocket ID claim, so the request
    // and the journal record a person rather than "daedalus".
    const actor = context.actor()
    return { id: await requestClaudeSessionResume({ actor, session: data.session }) }
  })

/**
 * End one session. The selector's shape says which verb the host uses: a uuid
 * is a session this box started (`systemctl stop`, which SIGTERMs the unit's
 * cgroup), an eight-digit id is a background agent (`claude stop`, which keeps
 * the conversation for `claude attach`).
 */
export const stopSessionFn = adminFn
  .validator(sessionSelector)
  .handler(async ({ data, context }) => {
    const { requestClaudeSessionStop } = await import('../host/claude-session-request')
    const actor = context.actor()
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
export const removeSessionFn = adminFn
  .validator(sessionSelector)
  .handler(async ({ data, context }) => {
    const { requestClaudeSessionRemove } = await import('../host/claude-session-request')
    const actor = context.actor()
    return { id: await requestClaudeSessionRemove({ actor, session: data.session }) }
  })

export const fetchClaudeSessionStatusFn = readFn.handler(async () => {
  const { readClaudeSessionStatus } = await import('../host/claude-session-request')
  return readClaudeSessionStatus()
})

/** The Claude page for one node: its row and its live status page. */
export const fetchNodeClaudeFn = readFn
  .validator(asValidator(withMessage(obj({ id: nodeIdField }), 'expected a node id')))
  .handler(async ({ data }) => {
    const { loadNodeClaude } = await import('../lib/dashboard/node-claude')
    return loadNodeClaude(data.id)
  })

/* ── moving this box's Claude Code pin ────────────────────────────────── */

export const fetchClaudeCodeUpdateStatus = readFn.handler(async () => {
  const { readClaudeCodeUpdateStatus } = await import('../host/claude-code-update')
  return readClaudeCodeUpdateStatus()
})

/**
 * Ask the host to pin the current Claude Code release and rebuild onto it.
 *
 * Nothing to validate: the request carries only the actor. Which release is
 * current, whether its manifest is signed by Anthropic's key, and whether
 * the box is in a state to take it are all the host's answers, reported
 * through the status file the caller polls.
 *
 * Note what `done` means here — pinned and pushed, with an engine update
 * asked for. The rebuild that actually installs it belongs to
 * `fetchEngineUpdateStatus`, which is what the page follows next.
 */
export const requestClaudeCodeUpdateFn = adminFn.handler(async ({ context }) => {
  const { runClaudeCodeUpdate } = await import('../host/claude-code-flow')
  return runClaudeCodeUpdate({ actor: context.actor() })
})
