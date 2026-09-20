import { describe, expect, it } from 'vitest'
import { NO_META } from './claude-meta'
import {
  type ClaudeAgent,
  type ClaudeRoster,
  type ClaudeTranscript,
  countByState,
  isAgentId,
  isSessionId,
  type LiveSession,
  NO_ROSTER,
  type RosterEntry,
  rowControl,
  sessionRows,
} from './claude-roster'

// Every fixture here is a shape the real tree on this box actually produces,
// because each one is a way the two sources disagree:
//
//   - a transcript whose opening bytes carry no timestamp at all (one starts
//     with a multi-megabyte base64 image; others open with `custom-title`,
//     `ai-title` or `mode` records, none of which are timestamped). The
//     snapshot reports startedAt: null rather than guessing.
//   - a 0-byte transcript. Counted by the snapshot, never listed: there is
//     nothing in it to resume.
//   - a title that came from the `<uuid>/custom-title.json` sidecar rather
//     than from a record inside the file.
//   - a background agent whose project directory no longer exists, so the
//     directory walk cannot see it and only `claude agents` can.
//   - an older session of the same working directory as one running right
//     now, which on disk looks exactly as resumable as anything else and
//     is one: `--resume` continues whichever id it is handed.

const transcript = (over: Partial<ClaudeTranscript> & { id: string }): ClaudeTranscript => ({
  project: '-etc-nixos',
  cwd: '/etc/nixos',
  cwdExact: true,
  title: null,
  titleSource: null,
  startedAt: 1_789_000_000_000,
  modifiedAt: 1_789_100_000_000,
  sizeBytes: 1024,
  // The join does not read the scan, so every case here gets the block the
  // host publishes when it has nothing. claude-meta.test.ts is where the
  // populated shapes are exercised.
  meta: NO_META,
  ...over,
})

const agent = (over: Partial<ClaudeAgent>): ClaudeAgent => ({
  id: null,
  sessionId: null,
  pid: null,
  kind: 'interactive',
  state: null,
  status: null,
  name: null,
  cwd: null,
  startedAt: null,
  ...over,
})

/** A connected session, as ~/.claude/sessions + /proc report one. */
const session = (over: Partial<LiveSession>): LiveSession => ({
  transcriptId: null,
  alive: true,
  pid: 1234,
  remoteId: null,
  name: null,
  status: null,
  cwd: '/etc/nixos',
  startedAt: 1_789_000_000_000,
  lastActivityAt: 1_789_100_000_000,
  cpuMs: null,
  rssBytes: null,
  ...over,
})

const roster = (over: Partial<ClaudeRoster>): ClaudeRoster => ({ ...NO_ROSTER, ...over })

describe('what a row IS', () => {
  it('a transcript with an interactive agent behind it is alive, and offers no resume', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [agent({ sessionId: 'abc', pid: 91660, status: 'busy', name: 'nixos-45' })],
        transcripts: [transcript({ id: 'abc' })],
      }),
    )
    expect(rows[0]?.state).toBe('alive')
    // A resume of a session that already has a process behind it starts a
    // copy of it, so the row offers none.
    expect(rows[0]?.canResume).toBe(false)
    expect(rows[0]?.lifecycle).toBe('busy')
    expect(rows[0]?.pid).toBe(91660)
  })

  it('a transcript with nothing behind it is resumable, and a resume continues that same session', () => {
    const rows = sessionRows(
      roster({ agentsAvailable: true, transcripts: [transcript({ id: 'x' })] }),
    )
    expect(rows[0]?.state).toBe('resumable')
    expect(rows[0]?.canResume).toBe(true)
    // `--resume` takes this id and keeps it: same session, same transcript,
    // appended to. Measured on CLI 2.1.260, with and without
    // `--remote-control`. Branching is `--fork-session`, which nothing here
    // passes — so the id the button offers is the id that comes back.
    expect(rows[0]?.id).toBe('x')
    expect(rows[0]?.shortId).toBeNull()
  })

  it('a background agent with a pid keeps its own lifecycle word and its short id', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [
          agent({
            id: '6913d790',
            sessionId: '6913d790-159e-4c03-81e2-93d6bd729bfa',
            kind: 'background',
            state: 'running',
            pid: 4021,
            name: 'nextjs-to-tanstack-migration',
            cwd: '/etc/nixos',
          }),
        ],
        transcripts: [transcript({ id: '6913d790-159e-4c03-81e2-93d6bd729bfa' })],
      }),
    )
    expect(rows[0]?.state).toBe('background')
    expect(rows[0]?.lifecycle).toBe('running')
    // The short id is what `claude attach`/`stop` take — never the uuid.
    expect(rows[0]?.shortId).toBe('6913d790')
    // Still running, so it is attached to rather than resumed.
    expect(rows[0]?.canResume).toBe(false)
  })

  it('an agent whose project directory is gone still gets a row', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [
          agent({
            id: '3ab35c23',
            sessionId: '3ab35c23-d56d-4f8d-a5f6-a4f56ec384ee',
            kind: 'background',
            state: 'running',
            pid: 8813,
            name: 'Adversarial security assessment of s2-server',
            cwd: '/home/santiago/selfhost',
          }),
        ],
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.onDisk).toBe(false)
    expect(rows[0]?.state).toBe('background')
    expect(rows[0]?.cwd).toBe('/home/santiago/selfhost')
    // No transcript under the scanned tree, so there is nothing to resume.
    expect(rows[0]?.canResume).toBe(false)
  })

  it('an interactive agent with no transcript is marked as such rather than dropped', () => {
    const rows = sessionRows(
      roster({ agentsAvailable: true, agents: [agent({ sessionId: 'ghost', pid: 4 })] }),
    )
    expect(rows[0]?.state).toBe('orphan')
    expect(rows[0]?.onDisk).toBe(false)
  })

  it('the live session roster alone is enough to keep a row off the resumable pile', () => {
    // A session in ~/.claude/sessions that `claude agents` did not report:
    // either source saying it is running must win, because a resume of a
    // session already in progress starts a second copy of it.
    const rows = sessionRows(roster({ transcripts: [transcript({ id: 'live' })] }), [
      session({ transcriptId: 'live' }),
    ])
    expect(rows[0]?.state).toBe('alive')
    expect(rows[0]?.canResume).toBe(false)
  })

  it('carries the connected session onto the row it is writing', () => {
    // The Sessions board used to draw these as a second list of the same
    // population. They arrive on the row now, and nothing that was only on
    // that board may be lost on the way.
    const rows = sessionRows(roster({ transcripts: [transcript({ id: 'live' })] }), [
      session({ transcriptId: 'live', remoteId: 'cse_abc', name: 'nixos-7a', rssBytes: 4_096 }),
    ])
    expect(rows[0]?.live?.remoteId).toBe('cse_abc')
    expect(rows[0]?.live?.name).toBe('nixos-7a')
    expect(rows[0]?.live?.rssBytes).toBe(4_096)
  })

  it('draws a connected session neither source knows about rather than dropping it', () => {
    // No transcript in the scanned tree and no agent — a session opened
    // outside ~/.claude/projects, or one running while `claude agents` is
    // unavailable. The Sessions board drew every live session
    // unconditionally, so folding it in here must not lose this one.
    const rows = sessionRows(roster({}), [session({ transcriptId: 'elsewhere', pid: 77 })])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.state).toBe('alive')
    expect(rows[0]?.onDisk).toBe(false)
    expect(rows[0]?.canResume).toBe(false)
    expect(rows[0]?.live?.pid).toBe(77)
  })

  it('does not draw a session file whose process is gone', () => {
    // A stale file in ~/.claude/sessions is counted in the board's foot, not
    // drawn as a row: there is no process left to describe.
    expect(sessionRows(roster({}), [session({ transcriptId: 'dead', alive: false })])).toEqual([])
  })

  it('an older session of a directory someone is working in now is resumable like any other', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [agent({ sessionId: 'current', pid: 91660 })],
        transcripts: [
          transcript({ id: 'current', modifiedAt: 2_000 }),
          transcript({ id: 'earlier', modifiedAt: 1_000 }),
        ],
      }),
    )
    // Sharing a cwd with a live session is not a relationship the board can
    // see or needs to: what makes a row resumable is a transcript with no
    // process on it, and resuming one continues that transcript alone.
    expect(rows.map((r) => [r.id, r.state, r.canResume])).toEqual([
      ['current', 'alive', false],
      ['earlier', 'resumable', true],
    ])
  })
})

describe('labels, and never content', () => {
  it('prefers a title the operator typed over one the model wrote', () => {
    const rows = sessionRows(
      roster({
        transcripts: [transcript({ id: 'a', title: 's2-server', titleSource: 'custom-title' })],
      }),
    )
    expect(rows[0]?.label).toBe('s2-server')
    expect(rows[0]?.labelSource).toBe('custom-title')
  })

  it('carries a sidecar title through as a sidecar title', () => {
    const rows = sessionRows(
      roster({
        transcripts: [transcript({ id: 'a', title: 's2-server', titleSource: 'sidecar' })],
      }),
    )
    expect(rows[0]?.labelSource).toBe('sidecar')
  })

  it("falls back to the CLI's derived name, and marks it as one", () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [agent({ sessionId: 'a', name: 'nixos-ac', pid: 7 })],
        transcripts: [transcript({ id: 'a' })],
      }),
    )
    expect(rows[0]?.label).toBe('nixos-ac')
    expect(rows[0]?.labelSource).toBe('agent')
  })

  it('falls back to the id, never to a line of the transcript', () => {
    const rows = sessionRows(
      roster({ transcripts: [transcript({ id: '63a9d108-9cb0-52ce-a893-2100b396d0e6' })] }),
    )
    expect(rows[0]?.label).toBe('63a9d108')
    expect(rows[0]?.labelSource).toBe('id')
  })
})

describe('what the snapshot could not read', () => {
  it('keeps a transcript whose opening bytes carried no timestamp', () => {
    // One transcript on this box opens with a multi-megabyte base64 image, so
    // the first 8 KB holds no parseable record at all. Every other field is
    // still a fact, and the row is worth drawing.
    const rows = sessionRows(roster({ transcripts: [transcript({ id: 'a', startedAt: null })] }))
    expect(rows[0]?.startedAt).toBeNull()
    expect(rows[0]?.modifiedAt).toBe(1_789_100_000_000)
  })

  it("borrows the agent's start time when the transcript has none", () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [agent({ sessionId: 'a', pid: 3, startedAt: 1_789_230_820_836 })],
        transcripts: [transcript({ id: 'a', startedAt: null })],
      }),
    )
    expect(rows[0]?.startedAt).toBe(1_789_230_820_836)
  })

  it('does not list a 0-byte transcript, and does not lose the count either', () => {
    // The snapshot never puts an empty transcript in `transcripts`; it counts
    // it. A session opened and never spoken to has nothing to resume.
    const r = roster({ transcripts: [transcript({ id: 'a' })], transcriptTotal: 1, emptyCount: 2 })
    expect(sessionRows(r)).toHaveLength(1)
    expect(r.emptyCount).toBe(2)
  })

  it('marks an un-slugged cwd as approximate, unless an agent supplied a real one', () => {
    const rows = sessionRows(
      roster({
        transcripts: [
          transcript({
            id: 'a',
            cwd: '/home/santiago/projects/personal/portfolio',
            cwdExact: false,
          }),
        ],
      }),
    )
    expect(rows[0]?.cwdExact).toBe(false)

    const withAgent = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [
          agent({ sessionId: 'a', pid: 1, cwd: '/home/santiago/projects/personal-portfolio' }),
        ],
        transcripts: [
          transcript({
            id: 'a',
            cwd: '/home/santiago/projects/personal/portfolio',
            cwdExact: false,
          }),
        ],
      }),
    )
    expect(withAgent[0]?.cwd).toBe('/home/santiago/projects/personal-portfolio')
    expect(withAgent[0]?.cwdExact).toBe(true)
  })

  it('renders nothing rather than throwing when the CLI did not answer', () => {
    expect(sessionRows(NO_ROSTER)).toEqual([])
    expect(countByState([])).toEqual({
      alive: 0,
      background: 0,
      dormant: 0,
      resumable: 0,
      orphan: 0,
    })
  })
})

describe('order', () => {
  it('puts what is running first, then the most recently written', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [agent({ sessionId: 'now', pid: 1 })],
        transcripts: [
          transcript({ id: 'old', modifiedAt: 1_000, sizeBytes: 70_000_000 }),
          transcript({ id: 'now', modifiedAt: 500 }),
          transcript({ id: 'mid', modifiedAt: 900 }),
        ],
      }),
    )
    expect(rows.map((r) => r.id)).toEqual(['now', 'old', 'mid'])
  })
})

// ── the verbs ─────────────────────────────────────────────────────────────
//
// Three populations die three different ways and a fourth does not die at all.
// `rowControl` is where that is decided once, so the board cannot drift into
// offering one button to all of them — which is the mistake that would kill
// the wrong thing, or claim to kill something it cannot.

describe('which verb a row is offered', () => {
  const rowFor = (r: ClaudeRoster, id: string) => {
    const row = sessionRows(r).find((x) => x.key === id)
    if (row === undefined) throw new Error(`no row ${id}`)
    return row
  }

  it('offers Resume to a transcript with nothing behind it, with the uuid as the selector', () => {
    const row = rowFor(roster({ transcripts: [transcript({ id: 'abc' })] }), 'abc')
    expect(row.state).toBe('resumable')
    expect(rowControl(row)).toEqual({ kind: 'resume', session: 'abc' })
  })

  // `claude stop` takes the SHORT id. Handing it the uuid is the bug this
  // asserts against: it would refuse, and the row would look broken.
  it('offers Stop to a RUNNING background agent, with the SHORT id as the selector', () => {
    const row = rowFor(
      roster({
        agentsAvailable: true,
        agents: [
          agent({
            id: 'dead',
            sessionId: 'deadbeef-1',
            kind: 'background',
            state: 'running',
            pid: 2211,
          }),
        ],
        transcripts: [transcript({ id: 'deadbeef-1' })],
      }),
      'deadbeef-1',
    )
    expect(row.state).toBe('background')
    expect(rowControl(row)).toEqual({ kind: 'stop-agent', session: 'dead' })
  })

  it('offers Stop to a session this box started, as its unit', () => {
    const row = rowFor(
      roster({
        agentsAvailable: true,
        agents: [agent({ sessionId: 'ours', pid: 42, status: 'busy' })],
        transcripts: [transcript({ id: 'ours' })],
        managedIds: ['ours'],
      }),
      'ours',
    )
    expect(row.state).toBe('alive')
    expect(row.managed).toBe(true)
    expect(rowControl(row)).toEqual({ kind: 'stop-unit', session: 'ours' })
  })

  // The honest gap. Nothing in the CLI or in systemd ends one of these on its
  // own, so the row must say so rather than draw a button that lies.
  it('offers nothing to a session the Remote Control server spawned', () => {
    const row = rowFor(
      roster({
        agentsAvailable: true,
        agents: [agent({ sessionId: 'theirs', pid: 7, status: 'busy' })],
        transcripts: [transcript({ id: 'theirs' })],
      }),
      'theirs',
    )
    expect(row.managed).toBe(false)
    expect(rowControl(row)).toEqual({ kind: 'none', why: 'server' })
  })

  it('offers nothing to a row with no transcript to resume and no unit to stop', () => {
    const rows = sessionRows(
      roster({ agentsAvailable: true, agents: [agent({ sessionId: 'gone', pid: 3 })] }),
    )
    expect(rows[0]?.state).toBe('orphan')
    expect(rowControl(rows[0] as RosterEntry)).toEqual({ kind: 'none', why: 'orphan' })
  })

  // Our own unit is up the moment the CLI execs — before the session file
  // exists and before `claude agents` has it. Without this a Resume pressed
  // twice inside a minute would look resumable the second time, and the
  // second press would put a copy on the same transcript.
  // ── the pid, which is the whole of the dormant/running split ────────────
  //
  // This is the bug the board shipped with: a `claude --bg` RECORD outlives
  // its process, so three agents whose processes died in a reboot weeks ago
  // were drawn as running and offered a Stop that could not mean anything.
  // `state: "blocked"` is the tell that ISN'T — it means waiting on a human —
  // and `pid` is the one that is.

  it('draws a background agent with no pid as dormant, not as running', () => {
    // Exactly the shape all three of this box's records are in: blocked, a
    // cliVersion from three releases ago, and no pid anywhere.
    const row = rowFor(
      roster({
        agentsAvailable: true,
        agents: [
          agent({
            id: '6913d790',
            sessionId: '6913d790-159e-4c03-81e2-93d6bd729bfa',
            kind: 'background',
            state: 'blocked',
            pid: null,
            name: 'nextjs-to-tanstack-migration',
            cwd: '/etc/nixos',
          }),
        ],
        transcripts: [transcript({ id: '6913d790-159e-4c03-81e2-93d6bd729bfa' })],
      }),
      '6913d790-159e-4c03-81e2-93d6bd729bfa',
    )
    expect(row.state).toBe('dormant')
    expect(row.pid).toBeNull()
    // The CLI's own word is kept and shown — it is just not what decides.
    expect(row.lifecycle).toBe('blocked')
    // Remove, not Stop: `claude stop` on this has nothing to act on.
    expect(rowControl(row)).toEqual({ kind: 'remove-agent', session: '6913d790' })
  })

  it('draws a dormant agent the same way when its transcript is not on disk', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [
          agent({
            id: '3ab35c23',
            sessionId: '3ab35c23-d56d-4f8d-a5f6-a4f56ec384ee',
            kind: 'background',
            state: 'blocked',
            name: 'Adversarial security assessment of s2-server',
            cwd: '/home/santiago/selfhost',
          }),
        ],
      }),
    )
    // Not `orphan`: the CLI still has a record with a verb on it, which is
    // the whole difference between this and a row with no handle at all.
    expect(rows[0]?.state).toBe('dormant')
    expect(rows[0]?.onDisk).toBe(false)
    expect(rowControl(rows[0] as RosterEntry)).toEqual({
      kind: 'remove-agent',
      session: '3ab35c23',
    })
  })

  it('offers a dormant record no Resume — attach is the verb, and rm is the button', () => {
    const row = rowFor(
      roster({
        agentsAvailable: true,
        agents: [
          agent({ id: 'e1875e75', sessionId: 'dorm', kind: 'background', state: 'blocked' }),
        ],
        transcripts: [transcript({ id: 'dorm' })],
      }),
      'dorm',
    )
    // There genuinely is no process behind it — and a resume would still be
    // wrong: it would put a second, interactive front on a conversation the
    // CLI is still holding as a background job.
    expect(row.canResume).toBe(false)
    expect(rowControl(row).kind).toBe('remove-agent')
  })

  it('counts dormant records apart from both running and resumable', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [
          agent({ id: 'aaaaaaaa', sessionId: 'a', kind: 'background', state: 'blocked' }),
          agent({ id: 'bbbbbbbb', sessionId: 'b', kind: 'background', state: 'running', pid: 12 }),
          agent({ sessionId: 'c', pid: 13, status: 'busy' }),
        ],
        transcripts: [
          transcript({ id: 'a' }),
          transcript({ id: 'b' }),
          transcript({ id: 'c' }),
          transcript({ id: 'd' }),
        ],
      }),
    )
    expect(countByState(rows)).toEqual({
      alive: 1,
      background: 1,
      dormant: 1,
      resumable: 1,
      orphan: 0,
    })
  })

  it('sorts dormant records above the resumable tail, and below what is running', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [
          agent({ id: 'aaaaaaaa', sessionId: 'dorm', kind: 'background', state: 'blocked' }),
        ],
        transcripts: [
          // The newest transcript by a wide margin, and still below the
          // dormant row: a record with a verb waiting on it must not be
          // buried under fifty transcripts, which is how it hid for weeks.
          transcript({ id: 'fresh', modifiedAt: 9_000 }),
          transcript({ id: 'dorm', modifiedAt: 1 }),
        ],
      }),
    )
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['dorm', 'dormant'],
      ['fresh', 'resumable'],
    ])
  })

  it('treats a managed uuid as running even when no other source has caught up', () => {
    const row = rowFor(
      roster({ transcripts: [transcript({ id: 'fresh' })], managedIds: ['fresh'] }),
      'fresh',
    )
    expect(row.state).toBe('alive')
    expect(row.canResume).toBe(false)
    expect(rowControl(row)).toEqual({ kind: 'stop-unit', session: 'fresh' })
  })
})

describe('the selector charset, which is the first of the host agent three layers', () => {
  it('accepts exactly the shape every transcript on this box has', () => {
    expect(isSessionId('11111111-2222-4333-8444-555555555555')).toBe(true)
    expect(isSessionId('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(true)
  })

  it.each([
    '../../etc/shadow',
    '$(id)',
    '11111111-2222-4333-8444-555555555555; rm -rf /',
    '11111111-2222-4333-8444-555555555555.service',
    '11111111-2222-4333-8444-55555555555',
    'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
    '',
  ])('refuses %s', (v) => {
    expect(isSessionId(v)).toBe(false)
  })

  it('knows a background agent id from a session id', () => {
    expect(isAgentId('deadbeef')).toBe(true)
    expect(isAgentId('DEADBEEF')).toBe(false)
    expect(isAgentId('deadbee')).toBe(false)
    expect(isAgentId('11111111-2222-4333-8444-555555555555')).toBe(false)
  })
})
