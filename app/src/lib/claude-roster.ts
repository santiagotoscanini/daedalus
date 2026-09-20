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
// ── what resume actually does ─────────────────────────────────────────────
//
// `claude --resume <id>` CONTINUES that session: same id, same transcript,
// appended to. Measured on this box with CLI 2.1.260, both plain and with
// `--remote-control` (the form a Resume button would use) — the transcript
// grew in place and the live session reported back the id it had been given.
// Branching is the opt-in, `--fork-session`; nothing here passes it.
//
// An earlier reading of the tree claimed the opposite. It inferred a fork
// from three transcripts with millisecond-adjacent timestamps; the experiment
// refuted that inference. What did produce those separate files is not known,
// and this module does not guess.
//
// So `canResume` below is about whether there is anything to pick up, not
// about what picking it up would do to it. A row that is already running is
// excluded for a different reason: the CLI's own help says a resume of a
// session that is already running starts a COPY and says so, and the board
// should not invite that. Background agents keep their own two verbs,
// `claude attach` and `claude stop`, which take the SHORT id, not the uuid.
//
// ── a background agent's RECORD outlives its process ──────────────────────
//
// The one thing `claude agents --json` will not tell you in a word. A
// `claude --bg` agent that asked a question and never got an answer sits at
// `state: "blocked"` — which means "waiting on a human", not "running" — and
// when the process behind it dies (a reboot, an upgrade, an OOM) the RECORD
// survives it unchanged. All three background rows on this box are in exactly
// that shape: `state: "blocked"`, `cliVersion` from three CLI releases ago,
// and no process anywhere.
//
// The field that separates the two is `pid`. The CLI reports one for an agent
// it has a process for and omits it otherwise, so:
//
//   pid present  genuinely running. `claude stop <short id>` ends it.
//   pid absent   DORMANT. There is nothing to stop; `claude stop` would be a
//                verb with no object. What is left is the record, and the verb
//                for a record is `claude rm <short id>` — the CLI's own help
//                is explicit that `rm`, unlike `stop`, "works on already-exited
//                sessions". `claude attach <short id>` still reopens the
//                conversation, which is why Remove is offered rather than done.
//
// Drawing a dormant record as running is the bug this distinction exists to
// kill: it offered Stop on a row nothing could stop, and every press mailed
// the fleet about a failure that was really a record that had never moved.
//
// What is NOT read here, ever: the `detail` the agent last printed and the
// `needs` question it is parked on, both of which sit in
// `~/.claude/jobs/<id>/state.json`. Those are session CONTENT. The snapshot
// now carries exactly one line of that — a row's last prompt, truncated and
// redacted host-side, which the operator asked for and which paid for itself
// by the file being tightened to 0600 first — and these two are not it:
// nobody asked for them, and neither is bounded the way one cut prompt is.
// State and liveness are facts about the machine; the question the agent
// asked is not.
//
// ── the trap behind the Resume button ─────────────────────────────────────
//
// An interactive `claude` in a directory whose trust has never been accepted
// blocks on "Is this a project you created or one you trust?" and starts
// nothing at all. From a systemd unit that is a hang with nobody able to
// answer the prompt. `/etc/nixos` is already trusted so the common case is
// fine, but a row's `cwd` is any directory a session was once opened in and
// carries no such guarantee — which is why the host runs a resume in
// /etc/nixos and nowhere else, refusing any other cwd up front rather than
// leaving a unit started and useless. The guard is in
// stacks/daedalus/host/claude-session.sh; host/claude-session-request.ts
// carries the rest of the selector rules.

// Type only, and the dependency points this way on purpose: claude-meta.ts
// knows nothing about rosters, so it can be tested against a bare meta block.
import type { LiveFacts, TranscriptMeta } from './claude-meta'
import { NO_META } from './claude-meta'

/**
 * A connected session, as this module needs it.
 *
 * Declared structurally rather than imported from lib/dashboard/claude.ts: the
 * rule at the top of this file is that the dependency points from the host
 * module to the pure one and never back. `ClaudeSession` satisfies this shape,
 * so the loader's array passes straight in.
 */
export type LiveSession = LiveFacts & {
  transcriptId: string | null
  alive: boolean
  pid: number
  /** `cse_…` — the id claude.ai shows. Only bridge-started sessions have one. */
  remoteId: string | null
  /** The CLI's derived short label, e.g. `nixos-7a`. What claude.ai shows. */
  name: string | null
  /** `busy` while it is mid-turn. The CLI's word, which no clock can infer. */
  status: string | null
  cwd: string | null
}

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

/**
 * One transcript on disk.
 *
 * Labels and counts — and exactly one line of content, `meta.lastPrompt`,
 * which the operator asked for and which is redacted and cut host-side before
 * it is written. Nothing else from the conversation is here; the titles are
 * still derived labels. See the "last prompt" section of
 * stacks/daedalus/host/claude-snapshot.sh for the trade and its residual risk.
 */
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
  /**
   * What the host's scan counted in this file — see lib/claude-meta.ts.
   *
   * Always an object, never absent: a snapshot written before the scan
   * existed decodes to `NO_META`, whose every field is null, so a row from
   * either era is read the same way and neither side invents a zero.
   */
  meta: TranscriptMeta
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
  /**
   * Session uuids running as `claude-session@<uuid>.service` — the ones this
   * box started, and the only live ones it can end.
   *
   * A third source, because neither of the two above can answer this: a
   * session the Remote Control server spawned looks identical in
   * `claude agents` and has no per-session kill at all. Without this the board
   * would have to offer every live row the same button and be wrong about half
   * of them.
   */
  managedIds: string[]
}

export const NO_ROSTER: ClaudeRoster = {
  agentsAvailable: false,
  agents: [],
  transcripts: [],
  transcriptTotal: 0,
  emptyCount: 0,
  managedIds: [],
}

/**
 * A canonical lowercase session uuid — what `--resume` takes, and what a
 * `claude-session@` instance name is made of.
 *
 * The same charset the host agent applies as its first layer
 * (stacks/daedalus/host/claude-session.sh), restated here so a malformed
 * selector never becomes a request file at all. This side is not the only
 * guard and must not be the only guard; it is the one that keeps a mistyped
 * id from ever reaching the bridge. All 49 transcripts and 44 sidecar
 * directories on this box match it with zero exceptions.
 */
export const isSessionId = (v: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)

/** A background agent's SHORT id — what `claude attach` and `claude stop` take. */
export const isAgentId = (v: string): boolean => /^[0-9a-f]{8}$/.test(v)

/**
 * What a row IS, which is the one thing the board must not blur.
 *
 * - `alive` — a session process is running it now. Nothing to press.
 * - `background` — a `claude --bg` agent with a pid. Still running;
 *   `claude attach` genuinely returns to it.
 * - `dormant` — a `claude --bg` agent's record with NO pid. The conversation
 *   stopped, usually parked on a question nobody answered, and the process
 *   behind it is long gone; only the record is left. See the header.
 * - `resumable` — a transcript and no process. `--resume` picks it back up
 *   where it stopped.
 * - `orphan` — the CLI reports an agent whose transcript is not in the
 *   scanned tree. Real, and not reachable from a directory walk.
 */
export type SessionState = 'alive' | 'background' | 'dormant' | 'resumable' | 'orphan'

export type RosterEntry = {
  key: string
  /** The session uuid — what `--resume` would take. Null only for an orphan. */
  id: string | null
  /** The short id `claude attach`/`stop` take. Background agents only. */
  shortId: string | null
  label: string
  /**
   * Where the label came from, so the view can mark a derived one. In
   * preference order: a title the operator typed, the sidecar's, the CLI's
   * `ai-title`, the short name the CLI derives, and finally the id. A row
   * with no title falls back to that id rather than borrowing the prompt —
   * the one line of actual conversation on the card is the LAST PROMPT and
   * nothing else on it is, which is the distinction the two are drawn apart
   * to keep.
   */
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
  /**
   * What the host counted in this row's transcript, or `NO_META` where there
   * is no transcript to count — an agent whose project directory is gone has
   * nothing on disk, and every field saying "not known" is the honest shape
   * for that, not a row of zeroes.
   */
  meta: TranscriptMeta
  /**
   * There is a transcript here and nothing running it, so `--resume <id>`
   * would continue this very session. False for a row already running (a
   * resume of one starts a copy) and for a row with nothing on disk.
   *
   * Also false for a `dormant` background record, whose process is indeed
   * gone: a background agent is reopened with `claude attach <short id>`, the
   * CLI's own verb, which keeps it a background agent. Resuming its uuid would
   * start a second, interactive front on the same conversation.
   */
  canResume: boolean
  /**
   * This row is running as `claude-session@<id>.service` — a session THIS box
   * started, so `systemctl stop` ends it cleanly. False for every session the
   * Remote Control server spawned, which has no per-session kill at all.
   */
  managed: boolean
  /**
   * The connected session behind this row, where there is one.
   *
   * This is what the Sessions board used to be. That board drew the live
   * sessions, and this one drew the same sessions again as its `alive` rows —
   * one population, two lists, and a reader had to hold both to answer "what
   * is running". Everything that was only on that board (the `cse_…` id, the
   * CLI's own name, RSS, CPU, the session's own activity clock) arrives here
   * instead, on the row it describes.
   */
  live: LiveSession | null
}

/**
 * Which verb, if any, a row can be offered — the one decision the board must
 * not get wrong, because three of the four populations here die differently
 * and the fourth does not die at all.
 *
 * - `resume`   a transcript with nothing behind it. `claude --resume <uuid>`
 *              continues that very session: same id, same transcript.
 * - `stop-unit` a session this box started, ended by `systemctl stop` — the
 *              unit owns the cgroup, so there is no pid to match on.
 * - `stop-agent` a RUNNING `claude --bg` agent, ended by
 *              `claude stop <short id>`, upstream's own verb, which keeps the
 *              conversation.
 * - `remove-agent` a DORMANT `claude --bg` record — no pid, nothing to stop.
 *              `claude rm <short id>` is the verb that deletes it, and the
 *              CLI's help says it is the one that works on an already-exited
 *              session. Destructive where Stop is not: it takes the record and
 *              its worktree, so after it `claude attach` has nothing to open.
 * - `none`     nothing honest to offer. `server` is a session the Remote
 *              Control server spawned (it dies with its server, and the page
 *              says so rather than drawing a button that lies); `orphan` is a
 *              row with no transcript and no handle of any kind.
 *
 * `session` is the selector the host agent is handed, and it is NOT always the
 * uuid: `claude stop` and `claude rm` take the short id.
 */
export type RowControl =
  | { kind: 'resume'; session: string }
  | { kind: 'stop-unit'; session: string }
  | { kind: 'stop-agent'; session: string }
  | { kind: 'remove-agent'; session: string }
  | { kind: 'none'; why: 'server' | 'orphan' }

export function rowControl(row: RosterEntry): RowControl {
  // The two background populations first, and DORMANT before RUNNING: their
  // ids are not uuids, and the whole point of the split is that a record with
  // no process behind it must never be offered a Stop. `claude stop` on one
  // has no object — it is what put "failed" on the operator's screen for an
  // agent that had been dead for weeks.
  if (row.state === 'dormant' && row.shortId !== null) {
    return { kind: 'remove-agent', session: row.shortId }
  }
  if (row.state === 'background' && row.shortId !== null) {
    return { kind: 'stop-agent', session: row.shortId }
  }
  if (row.managed && row.id !== null) return { kind: 'stop-unit', session: row.id }
  if (row.canResume && row.id !== null) return { kind: 'resume', session: row.id }
  if (row.state === 'alive') return { kind: 'none', why: 'server' }
  return { kind: 'none', why: 'orphan' }
}

const shortId = (id: string): string => id.slice(0, 8)

/**
 * Join the two sources into one board.
 *
 * `live` is the Remote Control roster (~/.claude/sessions), which overlaps
 * the CLI's interactive agents but is not the same list: a session started at
 * the console appears in both, and one whose file is stale appears only in
 * the first. Either saying a uuid is running is enough to keep it off the
 * resumable pile: a resume of a session that already has a process behind it
 * starts a second copy of it, which is not what a row reading "resumable"
 * promises.
 */
export function sessionRows(
  roster: ClaudeRoster,
  live: readonly LiveSession[] = [],
): RosterEntry[] {
  const byId = new Map<string, ClaudeAgent>()
  for (const a of roster.agents) {
    if (a.sessionId !== null) byId.set(a.sessionId, a)
  }

  // The live sessions, by the transcript each one is writing. Kept as the
  // whole session rather than as a set of ids: the row it lands on is the only
  // place the Sessions board's facts have left to go.
  const liveById = new Map<string, LiveSession>()
  for (const s of live) {
    if (s.alive && s.transcriptId !== null) liveById.set(s.transcriptId, s)
  }

  // A third way to be running, and the earliest to know it: a session this box
  // resumed has its unit up the moment the CLI execs, well before the session
  // file exists or `claude agents` has it. Without this a Resume pressed twice
  // inside a minute would look resumable the second time.
  const managed = new Set(roster.managedIds)

  const rows: RosterEntry[] = roster.transcripts.map((t) => {
    const agent = byId.get(t.id) ?? null
    const background = agent !== null && agent.kind === 'background'
    // The pid, not the lifecycle word: `blocked` is a background agent waiting
    // on a human and says nothing about whether a process is still there. See
    // the header — the record outlives the process, routinely.
    const dormant = background && agent.pid === null
    // `agent !== null` still counts a dormant record as "not resumable": the
    // CLI owns that conversation and `claude attach` is how it comes back.
    const session = liveById.get(t.id) ?? null
    const running = agent !== null || session !== null || managed.has(t.id)

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
      state: dormant ? 'dormant' : background ? 'background' : running ? 'alive' : 'resumable',
      lifecycle: background ? agent.state : (agent?.status ?? null),
      pid: agent?.pid ?? null,
      startedAt: t.startedAt ?? agent?.startedAt ?? null,
      modifiedAt: t.modifiedAt,
      sizeBytes: t.sizeBytes,
      onDisk: true,
      meta: t.meta,
      canResume: !running,
      managed: managed.has(t.id),
      live: session,
    }
  })

  const seenRows = new Set(roster.transcripts.map((t) => t.id))
  for (const a of roster.agents) {
    if (a.sessionId !== null && seenRows.has(a.sessionId)) continue
    if (a.sessionId !== null) seenRows.add(a.sessionId)
    const background = a.kind === 'background'
    const dormant = background && a.pid === null
    rows.push({
      key: a.sessionId ?? a.id ?? `agent-${String(a.pid ?? 0)}`,
      id: a.sessionId,
      shortId: background ? a.id : null,
      label: a.name ?? a.sessionId ?? a.id ?? 'unnamed',
      labelSource: a.name != null ? 'agent' : 'id',
      cwd: a.cwd,
      cwdExact: true,
      state: dormant ? 'dormant' : background ? 'background' : 'orphan',
      lifecycle: background ? a.state : a.status,
      pid: a.pid,
      startedAt: a.startedAt,
      modifiedAt: null,
      sizeBytes: null,
      onDisk: false,
      // Nothing was scanned, because there is no file to scan.
      meta: NO_META,
      // Nothing on disk under the scanned tree, so there is no transcript for
      // `--resume` to continue in the first place.
      canResume: false,
      // A row with no transcript is one our own units never started: the
      // instance name IS the transcript uuid.
      managed: a.sessionId !== null && managed.has(a.sessionId),
      live: a.sessionId === null ? null : (liveById.get(a.sessionId) ?? null),
    })
  }

  // A connected session neither source accounted for.
  //
  // The Sessions board drew every live session unconditionally; this board
  // draws what the two roster sources report. So a session whose transcript is
  // outside the scanned tree, or one running while `claude agents` is
  // unavailable, would simply have vanished when that board was folded in
  // here — and it is exactly the row a reader opens this page for.
  for (const s of live) {
    if (!s.alive) continue
    if (s.transcriptId !== null && seenRows.has(s.transcriptId)) continue
    rows.push({
      key: `live-${String(s.pid)}`,
      id: s.transcriptId,
      shortId: null,
      label: s.name ?? s.transcriptId ?? `pid ${String(s.pid)}`,
      labelSource: s.name != null ? 'agent' : 'id',
      cwd: s.cwd,
      cwdExact: true,
      state: 'alive',
      lifecycle: s.status,
      pid: s.pid,
      startedAt: s.startedAt,
      modifiedAt: null,
      sizeBytes: null,
      onDisk: false,
      meta: NO_META,
      // A resume needs a transcript, and the reason this row exists at all is
      // that no transcript for it was found.
      canResume: false,
      managed: s.transcriptId !== null && managed.has(s.transcriptId),
      live: s,
    })
  }

  // Running first, then by last write. A board whose top row is a 70 MB
  // transcript from last month, with the session you are typing into halfway
  // down, is sorted correctly and reads wrong.
  // Dormant above the resumable tail rather than in it: there are three of
  // them, each one has a verb waiting, and burying them under fifty
  // transcripts is how they stayed drawn as running for weeks.
  const RANK: Record<SessionState, number> = {
    alive: 0,
    background: 1,
    orphan: 2,
    dormant: 3,
    resumable: 4,
  }
  return rows.sort(
    (a, b) =>
      RANK[a.state] - RANK[b.state] ||
      (b.modifiedAt ?? b.startedAt ?? 0) - (a.modifiedAt ?? a.startedAt ?? 0),
  )
}

export function countByState(rows: readonly RosterEntry[]): Record<SessionState, number> {
  const out: Record<SessionState, number> = {
    alive: 0,
    background: 0,
    dormant: 0,
    resumable: 0,
    orphan: 0,
  }
  for (const r of rows) out[r.state] += 1
  return out
}
