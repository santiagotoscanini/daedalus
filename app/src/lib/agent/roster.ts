import type {
  ActionResult,
  Agent,
  Roster,
  Session,
  SessionStat,
  Transcript,
} from '../../host/controller/generated'
import {
  arrayOf,
  bool,
  int,
  nint,
  nnum,
  nstr,
  nullable,
  obj,
  oneOf,
  reads,
  str,
} from '../contract/decode'
import type { VerbOutcome } from '../follow-request'

// A machine's roster of Claude Code sessions, as its agent writes it
// (agent/src/claude/roster/): `claude.roster` on the box's controller,
// `nodes.claude_roster` for every other machine. The same document either
// way, so one decoder, held to the generated type; lib/claude-roster.ts joins
// it into the rows the Claude pages draw.
//
// Pure: no socket. host/controller/ reads the answers.

const agent = reads<Agent>()(
  obj({
    id: nstr,
    session_id: nstr,
    pid: nint,
    kind: nstr,
    state: nstr,
    status: nstr,
    name: nstr,
    cwd: nstr,
    started_at: nint,
  }),
)

const transcript = reads<Transcript>()(
  obj({
    id: str,
    project: str,
    cwd: str,
    cwd_exact: bool,
    title: nstr,
    title_source: nstr,
    started_at: nint,
    modified_at: int,
    size_bytes: int,
    meta: nullable(
      obj({
        exchanges: int,
        replies: int,
        thinking: int,
        images: int,
        attached: int,
        subagents: nint,
        span_ms: nint,
        branch: nstr,
        cli_version: nstr,
        last_prompt: nstr,
        cost: nullable(
          obj({ usd: nnum, lines_added: nnum, lines_removed: nnum, duration_ms: nnum }),
        ),
      }),
    ),
  }),
)

const actionResult = reads<ActionResult>()(
  obj({
    request: str,
    action: oneOf({ resume: true, stop: true, remove: true }),
    id: str,
    state: oneOf({ running: true, done: true, refused: true, failed: true }),
    detail: str,
    started_at: str,
    finished_at: nstr,
  }),
)

export const roster = reads<Roster>()(
  obj({
    reported_at: str,
    agents_available: bool,
    agents: arrayOf(agent),
    transcripts: arrayOf(transcript),
    transcript_total: int,
    empty_count: int,
    truncated: bool,
    managed: arrayOf(
      obj({
        id: str,
        job: str,
        pid: nint,
        memory_bytes: nint,
        cpu_nsec: nint,
        log: str,
        log_bytes: nint,
      }),
    ),
    session_stats: arrayOf(
      obj({ pid: int, cpu_ms: nint, rss_bytes: nint, log_bytes: nint, bridge_at: nint }),
    ),
    server: nullable(obj({ memory_bytes: nint, cpu_nsec: nint })),
    actions: arrayOf(actionResult),
    errors: arrayOf(str),
  }),
)

/** A connected session, with its cost where the roster measured it. */
export type ClaudeSession = Session & {
  cpu_ms: number | null
  rss_bytes: number | null
  log_bytes: number | null
}

/**
 * The report's sessions with the roster's per-process cost joined on by pid.
 *
 * `last_activity_at` becomes the later of two clocks: the session file's own
 * (the report) and the bridge debug log's mtime (the roster). Both, because a
 * session with no `cse_…` has no debug log, and the bridge log moves on
 * traffic the session file does not record. An idle reading of hours is a
 * session waiting, not a session broken.
 */
export function withStats(
  sessions: readonly Session[],
  stats: readonly SessionStat[],
): ClaudeSession[] {
  const byPid = new Map(stats.map((s) => [s.pid, s]))
  return sessions.map((s) => {
    const st = s.alive ? byPid.get(s.pid) : undefined
    const clocks = [s.last_activity_at, st?.bridge_at ?? null].filter((c) => c !== null)
    return {
      ...s,
      last_activity_at: clocks.length === 0 ? null : Math.max(...clocks),
      cpu_ms: st?.cpu_ms ?? null,
      rss_bytes: st?.rss_bytes ?? null,
      log_bytes: st?.log_bytes ?? null,
    }
  })
}

/** A session verb's result as lib/follow-request.ts follows it; null while the roster does not list it. */
export function sessionOutcome(a: ActionResult | null): VerbOutcome | null {
  return a === null ? null : { state: a.state, detail: a.detail }
}
