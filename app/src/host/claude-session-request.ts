import { isAgentId, isSessionId } from '../lib/claude-roster'
import { type Decoder, literal, nullable, obj, optional, str } from '../lib/contract/decode'
import { defineBridge } from './bridge'

// Asking the host to resume or end ONE Claude Code session.
//
// The most powerful verb on this bridge. Every other one starts a unit whose
// argv nix already fixed against a target nix already enumerated; a resume
// causes root to start a process AS THE OPERATOR, in the configuration checkout, with
// passwordless sudo on PATH, the operator's Claude credentials and GitHub SSH
// identity, and an outbound channel that exposes that shell to claude.ai.
//
// So this side sends a SELECTOR and nothing else. No path, no working
// directory, no flags — a `--permission-mode` the container could choose would
// be the whole ballgame. The argv lives in `claude-session@.service`
// (stacks/daedalus/daedalus.nix) and the three real guards live in
// stacks/daedalus/host/claude-session.sh: the uuid charset, the transcript
// having to exist as a regular file under a nix-rendered project slug, and the
// working directory having to be one nix trusts.
//
// The charset check below is therefore not the security control — it is the
// thing that keeps a mistyped id from ever becoming a request file. The host
// checks it again, as it must: this side is not the only guard and must never
// be the only guard.
//
// ── three verbs, two shapes of selector ───────────────────────────────────
//
// `resume` always takes the session uuid. `stop` takes whichever handle the
// row actually dies by: the uuid for a session this box started (the host
// ends it with `systemctl stop`, which SIGTERMs the unit's cgroup) and the
// eight-digit SHORT id for a `claude --bg` agent (the host ends it with
// `claude stop`, upstream's own verb, which keeps the conversation so
// `claude attach` can reopen it). The host decides which by the shape it
// reads plus what it finds running — never by a flag from here.
//
// `remove` is a background agent's short id and nothing else. It is the verb
// for a RECORD with no process behind it: `claude stop` on one has no object,
// and pressing it is what put a red "failed" on the board for an agent that
// had been dead for weeks. `claude rm` is what the CLI's own help points at
// for an already-exited session — and unlike `stop` it is destructive, since
// it takes the record and its worktree with it, so `claude attach` has
// nothing to reopen afterwards. The header of lib/claude-roster.ts carries
// the pid rule that decides which row gets which.
//
// Like claude-rc-request.ts, the agent outlives its action, so `done` and
// `failed` are both real terminal states and the ordinary status poll covers
// the flow end to end.

export type ClaudeSessionAction = 'resume' | 'stop' | 'remove'
export type ClaudeSessionState = 'idle' | 'running' | 'done' | 'failed'

export type ClaudeSessionStatus = {
  id: string | null
  action: ClaudeSessionAction | null
  /** The selector the host last acted on — a uuid, or a short agent id. */
  session: string | null
  state: ClaudeSessionState
  /** What the host is doing or did, in its words. */
  detail: string
  error: string
  startedAt: string | null
  finishedAt: string | null
}

/**
 * The status file the host agent writes; decoding `{}` is the idle status.
 *
 * Every field optional, for the reason defineBridge states: the file is
 * written by a root-side agent this container cannot see, one release at a
 * time, and a status from an older agent must still read rather than collapse
 * a running action into a button that re-enables itself.
 */
const CLAUDE_SESSION_STATUS: Decoder<ClaudeSessionStatus> = obj({
  id: optional(nullable(str), null),
  action: optional(nullable(literal('resume', 'stop', 'remove')), null),
  session: optional(nullable(str), null),
  state: optional(literal('idle', 'running', 'done', 'failed'), 'idle'),
  detail: optional(str, ''),
  error: optional(str, ''),
  startedAt: optional(nullable(str), null),
  finishedAt: optional(nullable(str), null),
})

const bridge = defineBridge<ClaudeSessionStatus>({
  requestFile: 'claude-session-request.json',
  statusFile: 'claude-session-status.json',
  status: CLAUDE_SESSION_STATUS,
})

export async function readClaudeSessionStatus(): Promise<ClaudeSessionStatus> {
  return bridge.readStatus()
}

/**
 * Resume one session. Throws — publishing NOTHING — on a selector that is not
 * a canonical lowercase uuid.
 *
 * A throw rather than a refusal status on purpose: a refusal status would
 * overwrite whatever the host last reported, so a malformed click would erase
 * the outcome of the previous real one. Nothing was asked of the host, so
 * nothing is said on its behalf.
 */
export async function requestClaudeSessionResume(input: {
  actor: string
  session: string
}): Promise<string> {
  if (!isSessionId(input.session)) {
    throw new Error('not a session id: a resume takes a canonical lowercase uuid')
  }
  return bridge.request({ action: 'resume', session: input.session, actor: input.actor })
}

/** End one session — a uuid for one this box started, a short id for an agent. */
export async function requestClaudeSessionStop(input: {
  actor: string
  session: string
}): Promise<string> {
  if (!isSessionId(input.session) && !isAgentId(input.session)) {
    throw new Error(
      'not a session id: a stop takes a canonical lowercase uuid or an eight-digit agent id',
    )
  }
  return bridge.request({ action: 'stop', session: input.session, actor: input.actor })
}

/**
 * Delete a dormant background agent's record — `claude rm <short id>`.
 *
 * A background agent's id only, and deliberately not a uuid: `rm` is the CLI's
 * own verb for its own job records, there is no session-uuid equivalent, and a
 * uuid arriving here would mean the board had confused a transcript with a
 * job. Throws — publishing nothing — rather than letting one through, for the
 * reason the resume above throws.
 */
export async function requestClaudeSessionRemove(input: {
  actor: string
  session: string
}): Promise<string> {
  if (!isAgentId(input.session)) {
    throw new Error('not an agent id: a remove takes an eight-digit background-agent id')
  }
  return bridge.request({ action: 'remove', session: input.session, actor: input.actor })
}
