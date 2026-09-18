// The session roster: what this box could still be asked about.
//
// Pure, and in `lib/` rather than beside the view, for the reason at the foot
// of lib/dashboard/claude.ts — that module reads the host snapshot through
// node:fs, so a component cannot import a value from it. The types below live
// here for the same reason and are imported BACK by the loader: the dependency
// points from the host module to the pure one, never the other way.
//
// ── the two sources, and why they stay two ────────────────────────────────
//
// stacks/daedalus/host/claude-snapshot.sh publishes them separately because
// they answer different questions and routinely disagree:
//
//   agents       `claude agents --json`. Authoritative for what is ALIVE, and
//                the only source at all for background agents — it knows ones
//                whose project directory no longer exists on disk.
//   transcripts  The `.jsonl` files. Authoritative for what is RESUMABLE, and
//                for nothing else: a transcript is a record that a
//                conversation happened, never evidence that anything is still
//                running behind it.
//
// The join is on the session uuid, and a row present on only one side is a
// reading rather than a gap — see `SessionState` below.
//
// ── the honest word for "resume" ──────────────────────────────────────────
//
// `claude --resume <id>` does NOT reattach. It mints a NEW session id and a
// NEW transcript, freezes the ancestor, and records no parent link between
// them — traced on this box as 63a9d108 → 61b502ae → the session that wrote
// this. Two consequences this module exists to keep the UI honest about:
//
//   - every dead ANCESTOR of a live session still looks resumable, because on
//     disk it is indistinguishable from any other frozen transcript;
//   - resuming forks a branch rather than returning to a conversation.
//
// Background agents are the exception: `claude attach <short id>` is a true
// reattach to a process that is still running. So the two are never given the
// same word here, and `resumeForks` is what the view reads to say so.

/** One `claude agents --json` entry, as the snapshot copies it out. */
export type ClaudeAgent = {
  /** The SHORT id — what `claude attach`/`stop` take. Background agents only. */
  id: string | null
  sessionId: string | null
  pid: number | null
  /** `background` (claude --bg) or `interactive`. */
  kind: string | null
  /** A background agent's lifecycle word: blocked, running… */
  state: string | null
  /** An interactive session's: busy. Deliberately not the same field. */
  status: string | null
  name: string | null
  cwd: string | null
  startedAt: number | null
}

/** One transcript on disk. Labels only — never a line of its content. */
export type ClaudeTranscript = {
  id: string
  /** The `~/.claude/projects/` directory name. */
  project: string
  cwd: string
  /** False = `cwd` was un-slugged from `project` and a dash may be wrong. */
  cwdExact: boolean
  title: string | null
  titleSource: string | null
  /** First timestamp in the file's opening bytes. Null is normal — see below. */
  startedAt: number | null
  modifiedAt: number
  sizeBytes: number
}

export type ClaudeRoster = {
  /** False = the CLI did not answer, so every row below is disk-only. */
  agentsAvailable: boolean
  agents: ClaudeAgent[]
  transcripts: ClaudeTranscript[]
  /** Non-empty transcripts on disk, before the snapshot's own cap. */
  transcriptTotal: number
  /** Opened and never spoken to. Counted, not listed: nothing to resume. */
  emptyCount: number
}

export const NO_ROSTER: ClaudeRoster = {
  agentsAvailable: false,
  agents: [],
  transcripts: [],
  transcriptTotal: 0,
  emptyCount: 0,
}

/**
 * What a row IS, which is the one thing the board must not blur.
 *
 * - `alive` — a session process is running it now. Nothing to press.
 * - `background` — a `claude --bg` agent. Still running; `claude attach`
 *   genuinely returns to it.
 * - `resumable` — a transcript and no process. `--resume` forks it.
 * - `orphan` — the CLI reports an agent whose transcript is not in the
 *   scanned tree. Real, and not reachable from a directory walk.
 */
export type SessionState = 'alive' | 'background' | 'resumable' | 'orphan'

export type RosterEntry = {
  key: string
  /** The session uuid — what `--resume` would take. Null only for an orphan. */
  id: string | null
  /** The short id `claude attach`/`stop` take. Background agents only. */
  shortId: string | null
  label: string
  /** Where the label came from, so the view can mark a derived one. */
  labelSource: 'custom-title' | 'sidecar' | 'ai-title' | 'agent' | 'id'
  cwd: string | null
  cwdExact: boolean
  state: SessionState
  /** The CLI's own word for this row's lifecycle, when it has one. */
  lifecycle: string | null
  pid: number | null
  startedAt: number | null
  /** Last write to the transcript. Null for a row with nothing on disk. */
  modifiedAt: number | null
  sizeBytes: number | null
  onDisk: boolean
  /** Pressing resume here would fork a branch rather than return to it. */
  resumeForks: boolean
}

const shortId = (id: string): string => id.slice(0, 8)

/**
 * Join the two sources into one board.
 *
 * `live` is the Remote Control roster (~/.claude/sessions), which overlaps
 * the CLI's interactive agents but is not the same list: a session started at
 * the console appears in both, and one whose file is stale appears only in
 * the first. Either saying a uuid is running is enough to keep it off the
 * resumable pile, because drawing a running session as resumable is the
 * mistake that costs a forked branch.
 */
export function sessionRows(
  roster: ClaudeRoster,
  live: readonly { transcriptId: string | null; alive: boolean }[] = [],
): RosterEntry[] {
  const byId = new Map<string, ClaudeAgent>()
  for (const a of roster.agents) {
    if (a.sessionId !== null) byId.set(a.sessionId, a)
  }

  const liveIds = new Set(
    live.filter((s) => s.alive && s.transcriptId !== null).map((s) => s.transcriptId as string),
  )

  const rows: RosterEntry[] = roster.transcripts.map((t) => {
    const agent = byId.get(t.id) ?? null
    const background = agent !== null && agent.kind === 'background'
    const running = background || agent !== null || liveIds.has(t.id)

    const label =
      t.title ??
      // The CLI's derived name is a poorer label than a title — `nixos-ac`
      // says nothing about the work — but it beats a bare uuid, and it is the
      // only name the operator sees for this session anywhere else.
      agent?.name ??
      shortId(t.id)
    const labelSource: RosterEntry['labelSource'] =
      t.title !== null
        ? t.titleSource === 'custom-title' || t.titleSource === 'sidecar'
          ? t.titleSource
          : 'ai-title'
        : agent?.name != null
          ? 'agent'
          : 'id'

    return {
      key: t.id,
      id: t.id,
      shortId: background ? (agent.id ?? shortId(t.id)) : null,
      label,
      labelSource,
      cwd: agent?.cwd ?? t.cwd,
      cwdExact: agent?.cwd != null ? true : t.cwdExact,
      state: background ? 'background' : running ? 'alive' : 'resumable',
      lifecycle: background ? agent.state : (agent?.status ?? null),
      pid: agent?.pid ?? null,
      startedAt: t.startedAt ?? agent?.startedAt ?? null,
      modifiedAt: t.modifiedAt,
      sizeBytes: t.sizeBytes,
      onDisk: true,
      resumeForks: !running,
    }
  })

  const seen = new Set(roster.transcripts.map((t) => t.id))
  for (const a of roster.agents) {
    if (a.sessionId !== null && seen.has(a.sessionId)) continue
    const background = a.kind === 'background'
    rows.push({
      key: a.sessionId ?? a.id ?? `agent-${String(a.pid ?? 0)}`,
      id: a.sessionId,
      shortId: background ? a.id : null,
      label: a.name ?? a.sessionId ?? a.id ?? 'unnamed',
      labelSource: a.name != null ? 'agent' : 'id',
      cwd: a.cwd,
      cwdExact: true,
      state: background ? 'background' : 'orphan',
      lifecycle: background ? a.state : a.status,
      pid: a.pid,
      startedAt: a.startedAt,
      modifiedAt: null,
      sizeBytes: null,
      onDisk: false,
      // Nothing on disk under the scanned tree, so there is no transcript for
      // `--resume` to fork in the first place.
      resumeForks: false,
    })
  }

  // Running first, then by last write. A board whose top row is a 70 MB
  // transcript from last month, with the session you are typing into halfway
  // down, is sorted correctly and reads wrong.
  const RANK: Record<SessionState, number> = { alive: 0, background: 1, orphan: 2, resumable: 3 }
  return rows.sort(
    (a, b) =>
      RANK[a.state] - RANK[b.state] ||
      (b.modifiedAt ?? b.startedAt ?? 0) - (a.modifiedAt ?? a.startedAt ?? 0),
  )
}

export function countByState(rows: readonly RosterEntry[]): Record<SessionState, number> {
  const out: Record<SessionState, number> = { alive: 0, background: 0, resumable: 0, orphan: 0 }
  for (const r of rows) out[r.state] += 1
  return out
}
