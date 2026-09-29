import type { SessionActionResult } from '../lib/agent/roster'
import { selectorError } from '../lib/claude-roster'
import {
  asValidator,
  literal,
  nullable,
  obj,
  optional,
  str,
  withMessage,
} from '../lib/contract/decode'
import { nodeIdField } from '../lib/contract/fields'
import { adminFn, readFn } from './fn'

// Server functions behind the Claude tab: a node's report, Remote Control's
// restart, the per-session actions and this box's Claude Code pin. The box's
// own report is a System tab, loaded by fetchModuleBoards like the others.

/**
 * Restart the Remote Control server, through the controller (`claude.restart`).
 *
 * Answers as soon as the controller has queued it for its session, which
 * restarts the `daedalus-claude-rc` unit with its next report. `unavailable`
 * when the controller runs no Remote Control or no session reports — the
 * page says so beside the button.
 */
export const restartClaudeFn = adminFn.handler(async ({ context }) => {
  const ctx = await context.ctx()
  return ctx.controller.claudeRestart()
})

/**
 * One verb on one Claude Code session — `resume`, `stop` or `remove` — on the
 * box (`node` null: the controller's `claude.session`) or on a machine
 * (`nodes.claude_session`). Answers the request id at once; the machine's
 * roster reports the outcome under it (`fetchClaudeActionFn`).
 *
 * The selector is the whole request: no path, no directory, no flag. Its
 * shape is checked here so a malformed one never leaves the app, and again by
 * the controller, the machine and its session, which also decide whether
 * anything answers to it (agent/src/claude/sessions.rs).
 */
export const claudeSessionFn = adminFn
  .validator(
    asValidator(
      withMessage(
        obj({
          node: optional(nullable(nodeIdField), null),
          action: literal('resume', 'stop', 'remove'),
          session: str,
        }),
        'expected a session verb',
      ),
    ),
  )
  .handler(async ({ data, context }) => {
    const why = selectorError(data.action, data.session)
    if (why !== null) throw new Error(`not a session id: ${why}`)
    const ctx = await context.ctx()
    return data.node === null
      ? ctx.controller.claudeSession(data.action, data.session)
      : ctx.controller.nodesClaudeSession(data.node, data.action, data.session)
  })

/**
 * How one verb request went, from the roster's `actions` — or null while the
 * roster does not list it yet.
 */
export const fetchClaudeActionFn = readFn
  .validator(
    asValidator(
      withMessage(
        obj({ node: optional(nullable(nodeIdField), null), request: str }),
        'expected a request id',
      ),
    ),
  )
  .handler(async ({ data, context }): Promise<SessionActionResult | null> => {
    const ctx = await context.ctx()
    const answer =
      data.node === null
        ? await ctx.controller.claudeRoster()
        : await ctx.controller.nodesClaudeRoster(data.node)
    return answer.roster?.actions.find((a) => a.request === data.request) ?? null
  })

/** The Claude page for one node: its row and its live status page. */
export const fetchNodeClaudeFn = readFn
  .validator(asValidator(withMessage(obj({ id: nodeIdField }), 'expected a node id')))
  .handler(async ({ data, context }) => {
    const { loadNodeClaude } = await import('../lib/dashboard/node-claude')
    return loadNodeClaude(await context.ctx(), data.id)
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
