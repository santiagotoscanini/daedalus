import type { ActionState, Roster, SessionAction } from '../../host/controller/generated'
import type { ClaudeAgent, ClaudeRoster, ClaudeTranscript } from '../claude-roster'
import {
  arrayOf,
  bool,
  decode,
  int,
  literal,
  nullable,
  num,
  obj,
  optional,
  reads,
  str,
} from '../contract/decode'
import type { NodeClaudeSession } from './status'

// A machine's roster of Claude Code sessions, as its agent reads it
// (agent/src/claude/roster.rs is the writer): `claude.roster` on the box's
// controller, `nodes.claude_roster` for every other machine. The same
// document either way, so one decoder, mapped here into the shapes the
// Claude pages draw (lib/claude-roster.ts joins it into rows).
//
// Pure: no socket. host/controller/ reads the answers and hands the body here.

/** One verb request and its outcome, under the request id the agent minted. */
export type SessionActionResult = {
  request: string
  action: SessionAction
  /** The selector it was given: a session uuid or a background agent's short id. */
  session: string
  /** How it ended (claude/mod.rs `ActionState`), `running` until it does. */
  state: ActionState
  /** What was done, or why not, in the agent's own sentence. */
  detail: string
  startedAt: string
  finishedAt: string | null
}

/** A live session's cost, joined to the report's sessions by pid (Linux only). */
export type SessionStat = {
  pid: number
  cpuMs: number | null
  rssBytes: number | null
  /** The Remote Control bridge's per-session debug log. */
  logBytes: number | null
  /** Its mtime: a clock the session file lacks. */
  bridgeAt: number | null
}

export type AgentRoster = {
  reportedAt: string
  roster: ClaudeRoster
  sessionStats: SessionStat[]
  /** The Remote Control unit's accounting, where it runs as a unit. */
  server: { memoryBytes: number | null; cpuNsec: number | null } | null
  /** The last verb requests, newest first. */
  actions: SessionActionResult[]
  /** Transcripts were dropped to keep the document within its cap. */
  truncated: boolean
  /** What the agent could not read, one line each. */
  errors: string[]
}

const nstr = optional(nullable(str), null)
const nint = optional(nullable(int), null)
const nnum = optional(nullable(num), null)

const agentShape = obj({
  id: nstr,
  session_id: nstr,
  pid: nint,
  kind: nstr,
  state: nstr,
  status: nstr,
  name: nstr,
  cwd: nstr,
  started_at: nint,
})

const transcriptShape = obj({
  id: str,
  project: optional(str, ''),
  cwd: optional(str, ''),
  cwd_exact: optional(bool, false),
  title: nstr,
  title_source: nstr,
  started_at: nint,
  modified_at: optional(int, 0),
  size_bytes: optional(int, 0),
  meta: optional(
    nullable(
      obj({
        exchanges: optional(int, 0),
        replies: optional(int, 0),
        thinking: optional(int, 0),
        images: optional(int, 0),
        attached: optional(int, 0),
        subagents: nint,
        span_ms: nint,
        branch: nstr,
        cli_version: nstr,
        last_prompt: nstr,
        cost: optional(
          nullable(obj({ usd: nnum, lines_added: nnum, lines_removed: nnum, duration_ms: nnum })),
          null,
        ),
      }),
    ),
    null,
  ),
})

const unitCost = obj({ memory_bytes: nint, cpu_nsec: nint })

const rosterShape = reads<Roster>()(
  obj({
    reported_at: optional(str, ''),
    agents_available: optional(bool, false),
    agents: optional(arrayOf(agentShape), []),
    transcripts: optional(arrayOf(transcriptShape), []),
    transcript_total: optional(int, 0),
    empty_count: optional(int, 0),
    truncated: optional(bool, false),
    managed: optional(arrayOf(obj({ id: str })), []),
    session_stats: optional(
      arrayOf(obj({ pid: int, cpu_ms: nint, rss_bytes: nint, log_bytes: nint, bridge_at: nint })),
      [],
    ),
    server: optional(nullable(unitCost), null),
    actions: optional(
      arrayOf(
        obj({
          request: str,
          action: literal('resume', 'stop', 'remove'),
          id: str,
          state: literal('running', 'done', 'refused', 'failed'),
          detail: optional(str, ''),
          started_at: optional(str, ''),
          finished_at: nstr,
        }),
      ),
      [],
    ),
    errors: optional(arrayOf(str), []),
  }),
)

type TranscriptWire = ReturnType<typeof transcriptShape>

function transcriptOf(t: TranscriptWire): ClaudeTranscript {
  const m = t.meta
  return {
    id: t.id,
    project: t.project,
    cwd: t.cwd,
    cwdExact: t.cwd_exact,
    title: t.title,
    titleSource: t.title_source,
    startedAt: t.started_at,
    modifiedAt: t.modified_at,
    sizeBytes: t.size_bytes,
    // A transcript the agent could not read has no meta: every field reads
    // as not known, never as zero.
    meta:
      m === null
        ? {
            exchanges: null,
            replies: null,
            thinking: null,
            images: null,
            attached: null,
            subagents: null,
            spanMs: null,
            branch: null,
            cliVersion: null,
            lastPrompt: null,
            cost: null,
          }
        : {
            exchanges: m.exchanges,
            replies: m.replies,
            thinking: m.thinking,
            images: m.images,
            attached: m.attached,
            subagents: m.subagents,
            spanMs: m.span_ms,
            branch: m.branch,
            cliVersion: m.cli_version,
            lastPrompt: m.last_prompt,
            cost:
              m.cost === null
                ? null
                : {
                    usd: m.cost.usd,
                    linesAdded: m.cost.lines_added,
                    linesRemoved: m.cost.lines_removed,
                    durationMs: m.cost.duration_ms,
                  },
          },
  }
}

function agentOf(a: ReturnType<typeof agentShape>): ClaudeAgent {
  return {
    id: a.id,
    sessionId: a.session_id,
    pid: a.pid,
    kind: a.kind,
    state: a.state,
    status: a.status,
    name: a.name,
    cwd: a.cwd,
    startedAt: a.started_at,
  }
}

/** Decode a roster (`claude.roster`'s or `nodes.claude_roster`'s `roster`); null for a null one. */
export function agentRoster(body: unknown): AgentRoster | null {
  if (body === null || body === undefined) return null
  const r = decode(rosterShape, body)
  return {
    reportedAt: r.reported_at,
    roster: {
      agentsAvailable: r.agents_available,
      agents: r.agents.map(agentOf),
      transcripts: r.transcripts.map(transcriptOf),
      transcriptTotal: r.transcript_total,
      emptyCount: r.empty_count,
      managedIds: r.managed.map((m) => m.id),
    },
    sessionStats: r.session_stats.map((s) => ({
      pid: s.pid,
      cpuMs: s.cpu_ms,
      rssBytes: s.rss_bytes,
      logBytes: s.log_bytes,
      bridgeAt: s.bridge_at,
    })),
    server:
      r.server === null ? null : { memoryBytes: r.server.memory_bytes, cpuNsec: r.server.cpu_nsec },
    actions: r.actions.map((a) => ({
      request: a.request,
      action: a.action,
      session: a.id,
      state: a.state,
      detail: a.detail,
      startedAt: a.started_at,
      finishedAt: a.finished_at,
    })),
    truncated: r.truncated,
    errors: r.errors,
  }
}

/** A connected session, with its cost where the roster measured it. */
export type ClaudeSession = NodeClaudeSession & {
  cpuMs: number | null
  rssBytes: number | null
  logBytes: number | null
}

/**
 * The report's sessions with the roster's per-process cost joined on by pid.
 *
 * `lastActivityAt` becomes the later of two clocks: the session file's own
 * (the report) and the bridge debug log's mtime (the roster). Both, because a
 * session with no `cse_…` has no debug log, and the bridge log moves on
 * traffic the session file does not record. An idle reading of hours is a
 * session waiting, not a session broken.
 */
export function withStats(
  sessions: readonly NodeClaudeSession[],
  stats: readonly SessionStat[],
): ClaudeSession[] {
  const byPid = new Map(stats.map((s) => [s.pid, s]))
  return sessions.map((s) => {
    const st = s.alive ? byPid.get(s.pid) : undefined
    const clocks = [s.lastActivityAt, st?.bridgeAt ?? null].filter((c) => c !== null)
    return {
      ...s,
      lastActivityAt: clocks.length === 0 ? null : Math.max(...clocks),
      cpuMs: st?.cpuMs ?? null,
      rssBytes: st?.rssBytes ?? null,
      logBytes: st?.logBytes ?? null,
    }
  })
}
