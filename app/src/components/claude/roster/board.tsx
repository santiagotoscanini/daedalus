/* ── the roster ───────────────────────────────────────────────────────────

   Everything a machine could still be asked about, joined from two sources
   that disagree on purpose (lib/claude-roster.ts), and the page's only list
   of connected sessions: one population in two lists would mean holding both
   to answer "what is running". A connected session's own facts — the
   claude.ai id, the CLI's name, RSS, CPU, its activity clock — are on its
   row. The `StatStrip` above is not a duplicate: `N of <max>` is a fact
   about the server, not about a session.

   The same board on the box (System › Claude) and on every machine's Claude
   tab: `node` null is the box's controller, an id is that machine. */

import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
// Pure: lib/agent/roster decodes the agent's roster; nothing here needs the machine.
import type { SessionAction } from '../../../host/controller/generated'
import { type ClaudeSession, sessionOutcome } from '../../../lib/agent/roster'
import {
  type ClaudeRoster,
  countByState,
  type RosterEntry,
  sessionRows,
} from '../../../lib/claude-roster'
import { num } from '../../../lib/format'
import { claudeSessionFn, fetchClaudeActionFn } from '../../../server/claude'
import { EMPTY, FOOT, LIST, MONO, NOTE } from '../../tokens'
import { useArmedKey } from '../../use-armed'
import { useVerbRequest } from '../../verb-request'
import { Board } from '../../viz'
import { CycleSessionsControl } from '../controls/cycle-sessions'
import { RC_ARM_MS } from '../shared'
import { RosterRow, type VerbStatus } from './row'

/** As many rows as read as a list rather than as a log. The rest are counted. */
const ROSTER_ROWS = 24

/** How long one verb may stay `running` in the roster before the board stops waiting. */
const VERB_WAIT_MS = 60_000

const VERB: Record<'resume' | 'stop-unit' | 'stop-agent' | 'remove-agent', SessionAction> = {
  resume: 'resume',
  'stop-unit': 'stop',
  'stop-agent': 'stop',
  'remove-agent': 'remove',
}

export function RosterBoard({
  roster,
  sessions,
  node,
  holds,
  missing,
  errors,
}: {
  roster: ClaudeRoster
  sessions: ClaudeSession[]
  /** The machine; null is the box's own controller. */
  node: string | null
  /** The CLI version the box's flake holds, for the cycle; null on a machine. */
  holds: string | null
  /** Why there is no roster, or null. */
  missing: string | null
  errors: string[]
}) {
  const router = useRouter()
  const rows = sessionRows(roster, sessions)
  // Session files with no process behind them. Not rows — there is nothing
  // running to draw — and not an error either, so a count is the whole of
  // what to say.
  const stale = sessions.filter((s) => !s.alive).length
  const shown = rows.slice(0, ROSTER_ROWS)

  // ONE poller and ONE armed row for the whole board: the poller follows one
  // request id at a time, so two rows acting at once would lose one's outcome,
  // and arming a second row must disarm the first.
  const [armed, arm, disarm] = useArmedKey<string>(RC_ARM_MS)
  const [acted, setActed] = useState<string | null>(null)
  const {
    busy: running,
    outcome,
    start,
  } = useVerbRequest({
    get: async (request) => sessionOutcome(await fetchClaudeActionFn({ data: { node, request } })),
    waitMs: VERB_WAIT_MS,
    onSettle: () => {
      void router.invalidate()
    },
  })
  const status: VerbStatus =
    outcome === null
      ? { id: null, state: 'idle', session: null, detail: '', error: '' }
      : {
          id: null,
          state: outcome.state,
          session: null,
          detail: outcome.detail,
          error: outcome.state === 'refused' || outcome.state === 'failed' ? outcome.detail : '',
        }

  return (
    <Board
      title="Session roster"
      icon="panels"
      span={12}
      aside={
        <span className={NOTE}>
          {missing !== null && rows.length === 0 ? 'no roster yet' : populationLine(rows)}
        </span>
      }
    >
      {/* Without a roster the connected sessions (from the report) are still
          drawn; what is missing is the rest — transcripts, agents, verbs. */}
      {missing !== null && (
        <p className={EMPTY}>
          No roster yet: {missing}. The connected sessions below come from the Remote Control
          report; the transcripts, the background agents and their verbs appear once the agent
          reports a roster, within a minute of it starting.
        </p>
      )}
      {rows.length === 0 ? (
        missing === null && (
          <p className={EMPTY}>
            No sessions, no transcripts and no agents. Nothing is connected — the server is still
            listening, and a session appears here within a minute of being started from claude.ai or
            the app — and there is nothing on disk to resume either, or nobody has ever run{' '}
            <span className={MONO}>claude</span> as this user.
          </p>
        )
      ) : (
        <ul className={LIST}>
          {shown.map((r) => (
            <RosterRow
              key={r.key}
              row={r}
              acting={acted === r.key}
              armed={armed === r.key}
              busy={running}
              status={status}
              refusal={null}
              onArm={() => {
                arm(r.key)
              }}
              onCancel={disarm}
              onConfirm={(control) => {
                disarm()
                setActed(r.key)
                start(async () => {
                  const sent = await claudeSessionFn({
                    data: { node, action: VERB[control.kind], session: control.session },
                  })
                  return { ok: true, value: sent.request }
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

      {/* Handed the board's own `running`: the poller follows one request at
          a time, so a cycle and a row button must never be pressed at once. */}
      {node === null && <CycleSessionsControl rows={rows} holds={holds} boardBusy={running} />}

      {stale > 0 && (
        <p className={FOOT}>
          {num(stale)} session {stale === 1 ? 'file' : 'files'} in{' '}
          <span className={MONO}>~/.claude/sessions</span> with no process behind{' '}
          {stale === 1 ? 'it' : 'them'} — left by a session that exited uncleanly. Not an error;
          worth watching only if it grows.
        </p>
      )}

      {errors.length > 0 && (
        <p className={FOOT}>The agent could not read everything: {errors.join('; ')}.</p>
      )}

      {/* ONE paragraph, deliberately: the board says the rest by itself (the
          chips and buttons are the populations and their verbs, an armed row
          states its cost), and the reasoning lives where the behaviour is —
          lib/claude-roster.ts (the two sources, the pid rule, the four verbs),
          lib/claude-meta.ts (the counts, the prompt, why a zero never prints),
          agent/src/claude/sessions.rs (the selector and its guards). What
          stays here is the one thing a reader would otherwise get WRONG, and
          the one limit on what the board is able to claim. */}
      <p className={FOOT}>
        <b>Resume continues the session it names.</b>{' '}
        <span className={MONO}>claude --resume &lt;id&gt;</span> keeps that id and appends to that
        same transcript — measured on CLI 2.1.260, at the console and under{' '}
        <span className={MONO}>--remote-control</span>. Branching is the opt-in,{' '}
        <span className={MONO}>--fork-session</span>, and nothing on this page passes it. Nothing
        writes an end-of-session marker either, so a transcript with no process behind it is all
        this board can honestly say: <b>resumable</b> means there is something to pick up, not that
        it finished.
      </p>
    </Board>
  )
}

/* `dormant` counted apart from `background` and `resumable`, because it is
   the population most easily read as one of them: a background RECORD with no
   process behind it is not running, and it is not resumable either — the CLI
   still owns that conversation.

   Only the populations that exist. Five counts with zeroes in three of them is
   a legend, not a reading — and the board's whole argument is that these five
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
