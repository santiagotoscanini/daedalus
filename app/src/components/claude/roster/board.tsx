/* ── the roster ───────────────────────────────────────────────────────────

   Everything this box could still be asked about, joined from two sources
   that disagree on purpose — and, since the Sessions board was folded into
   it, the only list of connected sessions on the page as well. That board
   drew the live sessions and this one drew the same sessions again as its
   `alive` rows; one population in two lists meant holding both to answer
   "what is running". What was only on that board — the `cse_…` id, the CLI's
   own name, RSS, CPU, and the session's own activity clock — is on the row it
   describes now. The `StatStrip` above is not a duplicate of either and
   stays: `N of 32` is a fact about the server, not about a session. */

// Types ONLY: the host module behind this type reads node:fs, so its idle
// shape is restated below rather than imported.
import type { ClaudeSessionStatus } from '../../../host/claude-session-request'
import { countByState, type RosterEntry, sessionRows } from '../../../lib/claude-roster'
import type { ClaudeData } from '../../../lib/dashboard/claude'
import { num } from '../../../lib/format'
import {
  fetchClaudeSessionStatusFn,
  removeSessionFn,
  resumeSessionFn,
  stopSessionFn,
} from '../../../server/claude'
import { usePolledStatus } from '../../status'
import { EMPTY, FOOT, LIST, MONO, NOTE } from '../../tokens'
import { useArmedKey } from '../../use-armed'
import { Board } from '../../viz'
import { CycleSessionsControl } from '../controls/cycle-sessions'
import { RC_ARM_MS } from '../shared'
import { RosterRow } from './row'

/** As many rows as read as a list rather than as a log. The rest are counted. */
const ROSTER_ROWS = 24

const SESSION_IDLE: ClaudeSessionStatus = {
  id: null,
  action: null,
  session: null,
  state: 'idle',
  detail: '',
  error: '',
  startedAt: null,
  finishedAt: null,
}

export function RosterBoard({ data }: { data: ClaudeData }) {
  const { roster } = data.facts
  const rows = sessionRows(roster, data.facts.sessions)
  // Session files with no process behind them. Carried over from the Sessions
  // board's foot: they are not rows — there is nothing running to draw — and
  // they are not an error either, so a count is the whole of what to say.
  const stale = data.facts.sessions.filter((s) => !s.alive).length
  const shown = rows.slice(0, ROSTER_ROWS)

  // ONE poller and ONE armed row for the whole board: there is one bridge
  // file behind every button here, so two rows acting at once is not a state
  // the host can be in, and arming a second row must disarm the first.
  const [armed, arm, disarm] = useArmedKey<string>(RC_ARM_MS)
  const { status, running, refusal, start } = usePolledStatus<ClaudeSessionStatus>({
    initial: SESSION_IDLE,
    fetch: () => fetchClaudeSessionStatusFn(),
    claimTimeoutMs: 30_000,
  })

  return (
    <Board
      title="Session roster"
      icon="panels"
      span={12}
      aside={<span className={NOTE}>{populationLine(rows)}</span>}
    >
      {rows.length === 0 ? (
        <p className={EMPTY}>
          No sessions, no transcripts and no agents. Nothing is connected — the server is still
          listening, and a session appears here within a minute of being started from claude.ai or
          the app — and there is nothing on disk to resume either. Failing that, this snapshot
          predates the roster (the boards above still read correctly without it), or nobody has ever
          run <span className={MONO}>claude</span> as this user.
        </p>
      ) : (
        <ul className={LIST}>
          {shown.map((r) => (
            <RosterRow
              key={r.key}
              row={r}
              armed={armed === r.key}
              busy={running}
              status={status}
              refusal={refusal}
              onArm={() => {
                arm(r.key)
              }}
              onCancel={disarm}
              onConfirm={(control) => {
                disarm()
                start(async () => {
                  const fn =
                    control.kind === 'resume'
                      ? resumeSessionFn
                      : control.kind === 'remove-agent'
                        ? removeSessionFn
                        : stopSessionFn
                  return { ok: true, value: (await fn({ data: { session: control.session } })).id }
                })
              }}
            />
          ))}
        </ul>
      )}

      {rows.length > shown.length && (
        <p className={FOOT}>
          {num(rows.length - shown.length)} older transcript
          {rows.length - shown.length === 1 ? '' : 's'} not listed, of {num(roster.transcriptTotal)}{' '}
          on disk.
          {roster.emptyCount > 0 && (
            <>
              {' '}
              {num(roster.emptyCount)} more {roster.emptyCount === 1 ? 'is' : 'are'} empty — opened
              and never spoken to, so there is nothing in them to resume.
            </>
          )}
        </p>
      )}

      {/* Handed the board's own `running`: one request file backs every verb
          here, so a cycle and a row button must never be pressed at once. */}
      <CycleSessionsControl rows={rows} holds={data.facts.cli.version} boardBusy={running} />

      {stale > 0 && (
        <p className={FOOT}>
          {num(stale)} session {stale === 1 ? 'file' : 'files'} in{' '}
          <span className={MONO}>~/.claude/sessions</span> with no process behind{' '}
          {stale === 1 ? 'it' : 'them'} — left by a session that exited uncleanly. Not an error;
          worth watching only if it grows.
        </p>
      )}

      {/* ONE paragraph, deliberately. This foot carried ten, and nine of them
          explained things the board now says by itself: the populations and
          their verbs are the chips and the buttons, a dormant row prints `no
          process`, an armed row states what the press costs, and a fact the
          CLI never recorded is simply absent from the metadata line. That
          reasoning was not deleted, only moved to where the behaviour is —
          lib/claude-roster.ts (two sources, the pid rule, the four verbs, the
          trust guard), lib/claude-meta.ts (how the counts and the prompt are
          derived, why a zero never prints, what the file mode pays for),
          lib/dashboard/claude.ts (the two clocks behind "last seen"),
          host/claude-session-request.ts (the selector and its guards),
          host/claude-rc-request.ts (what a restart does to a session).
          What stays here is the one thing a reader would otherwise get
          WRONG, and the one limit on what the board is able to claim. */}
      <p className={FOOT}>
        <b>Resume continues the session it names.</b>{' '}
        <span className={MONO}>claude --resume &lt;id&gt;</span> keeps that id and appends to that
        same transcript — measured here on CLI 2.1.260, at the console and under{' '}
        <span className={MONO}>--remote-control</span>. Branching is the opt-in,{' '}
        <span className={MONO}>--fork-session</span>, and nothing on this page passes it. Nothing
        writes an end-of-session marker either, so a transcript with no process behind it is all
        this board can honestly say: <b>resumable</b> means there is something to pick up, not that
        it finished.
      </p>
    </Board>
  )
}

/* `dormant` counted apart from both, because it is the population that was
   being read as the wrong one: a background RECORD with no process behind it
   is not running, and it is not resumable either — the CLI still owns that
   conversation.

   Only the populations that exist. Four counts with zeroes in two of them is
   a legend, not a reading — and the board's whole argument is that these four
   are different things, which is easiest to see when only the present ones
   are named. */
function populationLine(rows: RosterEntry[]): string {
  if (rows.length === 0) return 'nothing connected, nothing on disk'
  const counts = countByState(rows)
  return (
    [
      [counts.alive, 'connected'],
      [counts.background, 'background'],
      [counts.dormant, 'dormant'],
      [counts.orphan, 'no transcript'],
      [counts.resumable, 'resumable'],
    ] as const
  )
    .filter(([k]) => k > 0)
    .map(([k, word]) => `${num(k)} ${word}`)
    .join(' · ')
}
