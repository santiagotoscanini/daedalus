import { describe, expect, it } from 'vitest'
import {
  type ClaudeAgent,
  type ClaudeRoster,
  type ClaudeTranscript,
  countByState,
  NO_ROSTER,
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
//   - a dead ANCESTOR of a session that is running right now, which looks
//     exactly as resumable as anything else and is the reason the board must
//     say resume forks.

const transcript = (over: Partial<ClaudeTranscript> & { id: string }): ClaudeTranscript => ({
  project: '-etc-nixos',
  cwd: '/etc/nixos',
  cwdExact: true,
  title: null,
  titleSource: null,
  startedAt: 1_789_000_000_000,
  modifiedAt: 1_789_100_000_000,
  sizeBytes: 1024,
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

const roster = (over: Partial<ClaudeRoster>): ClaudeRoster => ({ ...NO_ROSTER, ...over })

describe('what a row IS', () => {
  it('a transcript with an interactive agent behind it is alive, and does not fork', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [agent({ sessionId: 'abc', pid: 91660, status: 'busy', name: 'nixos-45' })],
        transcripts: [transcript({ id: 'abc' })],
      }),
    )
    expect(rows[0]?.state).toBe('alive')
    expect(rows[0]?.resumeForks).toBe(false)
    expect(rows[0]?.lifecycle).toBe('busy')
    expect(rows[0]?.pid).toBe(91660)
  })

  it('a transcript with nothing behind it is resumable, and resuming forks it', () => {
    const rows = sessionRows(
      roster({ agentsAvailable: true, transcripts: [transcript({ id: 'x' })] }),
    )
    expect(rows[0]?.state).toBe('resumable')
    expect(rows[0]?.resumeForks).toBe(true)
    expect(rows[0]?.shortId).toBeNull()
  })

  it('a background agent keeps its own lifecycle word and its short id', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [
          agent({
            id: '6913d790',
            sessionId: '6913d790-159e-4c03-81e2-93d6bd729bfa',
            kind: 'background',
            state: 'blocked',
            name: 'nextjs-to-tanstack-migration',
            cwd: '/etc/nixos',
          }),
        ],
        transcripts: [transcript({ id: '6913d790-159e-4c03-81e2-93d6bd729bfa' })],
      }),
    )
    expect(rows[0]?.state).toBe('background')
    expect(rows[0]?.lifecycle).toBe('blocked')
    // The short id is what `claude attach`/`stop` take — never the uuid.
    expect(rows[0]?.shortId).toBe('6913d790')
    expect(rows[0]?.resumeForks).toBe(false)
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
            state: 'blocked',
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
    // Nothing on disk to fork, so the fork warning must not be shown.
    expect(rows[0]?.resumeForks).toBe(false)
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
    // either source saying it is running must win, because drawing a running
    // session as resumable is what costs a forked branch.
    const rows = sessionRows(roster({ transcripts: [transcript({ id: 'live' })] }), [
      { transcriptId: 'live', alive: true },
    ])
    expect(rows[0]?.state).toBe('alive')
    expect(rows[0]?.resumeForks).toBe(false)
  })

  it('a dead ancestor of a live session is resumable, like any other transcript', () => {
    const rows = sessionRows(
      roster({
        agentsAvailable: true,
        agents: [agent({ sessionId: 'child', pid: 91660 })],
        transcripts: [
          transcript({ id: 'child', modifiedAt: 2_000 }),
          transcript({ id: 'ancestor', modifiedAt: 1_000 }),
        ],
      }),
    )
    // Nothing on disk distinguishes an ancestor from any other frozen
    // transcript — there is no parent link — so the board must not pretend.
    expect(rows.map((r) => [r.id, r.state])).toEqual([
      ['child', 'alive'],
      ['ancestor', 'resumable'],
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
    expect(countByState([])).toEqual({ alive: 0, background: 0, resumable: 0, orphan: 0 })
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
