import { describe, expect, it } from 'vitest'
import {
  factGroups,
  type LiveFacts,
  NO_META,
  promptLine,
  type RowShape,
  type TranscriptMeta,
} from './claude-meta'

// Every `meta` block below is one the host script actually published for a
// real transcript on this box — captured from /run/daedalus-claude/claude.json
// rather than invented — because the properties worth testing here are all
// properties of ABSENCE, and absence is the thing a hand-written fixture gets
// wrong. The three shapes the roster on this box produces today:
//
//   no last-prompt   5 of 49 transcripts have no `last-prompt` record at all.
//                    One of them also carries a cost-state whose every figure
//                    is zero, which is a second absence wearing a number.
//   no cost-state    46 of 49. The common case.
//   unparseable head The first 8 KB the snapshot reads did not yield a
//                    timestamp or a cwd, so the row falls back to the project
//                    directory name (`cwdExact: false`) and has no startedAt.
//                    The scan still counted the file: the two are independent
//                    reads and one failing must not blank the other.

const NOW = 1_789_920_000_000

const row = (over: Partial<RowShape>): RowShape => ({
  cwd: '/etc/nixos',
  cwdExact: true,
  sizeBytes: 1024,
  modifiedAt: NOW - 60_000,
  meta: NO_META,
  ...over,
})

const meta = (over: Partial<TranscriptMeta>): TranscriptMeta => ({
  ...NO_META,
  ...over,
  scanVersion: 1,
})

/** The groups this line is made of, as `key -> text`. */
const byKey = (r: RowShape): Record<string, string> =>
  Object.fromEntries(factGroups(r, NOW).map((g) => [g.key, g.text]))

describe('factGroups', () => {
  it('groups the directory and the branch into one fact', () => {
    const g = byKey(row({ meta: meta({ branch: 'main' }) }))
    expect(g.where).toBe('/etc/nixos on main')
  })

  it('drops the branch rather than the directory when only one is known', () => {
    expect(byKey(row({})).where).toBe('/etc/nixos')
  })

  it('marks a directory reconstructed from the project name', () => {
    const groups = factGroups(row({ cwdExact: false, meta: meta({ branch: 'main' }) }), NOW)
    const where = groups.find((x) => x.key === 'where')
    expect(where?.text).toBe('/etc/nixos? on main')
    // The mark belongs to the DIRECTORY, which is the half that was guessed
    // — the branch was read from the file. And the mark alone is not an
    // explanation, so the long form is on the title attribute.
    expect(where?.detail).toContain('reconstructed')
  })

  it('groups the turn count and the file size into one fact', () => {
    const g = byKey(row({ sizeBytes: 6_985_123, meta: meta({ exchanges: 37, replies: 587 }) }))
    expect(g.size).toBe('37 exchanges · 6.7 MB')
  })

  it('groups the span and the idle time into one story', () => {
    const g = byKey(
      row({ modifiedAt: NOW - 4 * 86_400_000, meta: meta({ spanMs: 3 * 3_600_000 }) }),
    )
    expect(g.time).toBe('3h · idle 4d')
  })

  // ── the three real shapes ───────────────────────────────────────────────

  it('a transcript with no last-prompt still reports everything else', () => {
    // 61b502ae on this box: no last-prompt record anywhere in the file.
    const r = row({
      sizeBytes: 2813,
      modifiedAt: 1_789_564_589_000,
      meta: meta({
        exchanges: 2,
        replies: 0,
        thinking: 0,
        images: 0,
        attached: 0,
        subagents: 0,
        spanMs: 56_976_000,
        branch: 'main',
        cliVersion: '2.1.260',
        lastPrompt: null,
        // Present, and every figure in it zero. Nothing to say is not the
        // same as nothing to show, and this is the case that proves the
        // difference: the record exists, so `cost` is not null, and the
        // group must still be absent.
        cost: { usd: 0, linesAdded: 0, linesRemoved: 0, durationMs: 56_975_667 },
      }),
    })
    const g = byKey(r)
    expect(promptLine(r.meta)).toBeNull()
    expect(g.where).toBe('/etc/nixos on main')
    expect(g.size).toBe('2 exchanges · 2.7 KB')
    expect(g.cli).toBe('v2.1.260')
    expect(g.cost).toBeUndefined()
    // Four zero counts and not one of them drawn.
    expect(g.extras).toBeUndefined()
  })

  it('a transcript with no cost-state shows no cost at all', () => {
    // 82046fed on this box.
    const r = row({
      sizeBytes: 388_288,
      modifiedAt: 1_789_909_282_000,
      meta: meta({
        exchanges: 1,
        replies: 22,
        thinking: 6,
        spanMs: 188_000,
        branch: 'main',
        cliVersion: '2.1.260',
        lastPrompt: 'why are we having grafana alerts open?',
        cost: null,
      }),
    })
    const g = byKey(r)
    expect(g.cost).toBeUndefined()
    expect(g.extras).toBe('6 thinking')
    expect(promptLine(r.meta)).toBe('why are we having grafana alerts open?')
  })

  it('a row whose head did not parse keeps the counts the scan did make', () => {
    // f753d87c on this box: no timestamp and no cwd in the first 8 KB, so the
    // directory is un-slugged and startedAt is null — while the scan, which
    // reads the whole file, counted 9 exchanges and 312 replies.
    const r = row({
      cwdExact: false,
      sizeBytes: 22_386_908,
      modifiedAt: 1_788_833_641_000,
      meta: meta({
        exchanges: 9,
        replies: 312,
        spanMs: 23_155_000,
        branch: 'main',
        cliVersion: '2.1.259',
      }),
    })
    const g = byKey(r)
    expect(g.where).toBe('/etc/nixos? on main')
    expect(g.size).toBe('9 exchanges · 21 MB')
    expect(g.cli).toBe('v2.1.259')
  })

  it('a row the host never scanned says nothing rather than zero', () => {
    // NO_META is what a snapshot written before the scan existed decodes to,
    // and what the host publishes for a row it could not read. The failure
    // this guards is a line of `0 exchanges · 0 thinking`, which is a lie
    // with the shape of a measurement.
    const groups = factGroups(row({ sizeBytes: 4096, meta: NO_META }), NOW)
    expect(groups.map((x) => x.key)).toEqual(['where', 'size', 'time'])
    expect(groups.find((x) => x.key === 'size')?.text).toBe('4.0 KB')
  })

  it('never prints a subagent count the CLI did not record', () => {
    // null (the marker was never written) and 0 (it was, and was false on
    // every record — the state of all 49 transcripts here) are both silence.
    expect(byKey(row({ meta: meta({ subagents: null }) })).extras).toBeUndefined()
    expect(byKey(row({ meta: meta({ subagents: 0 }) })).extras).toBeUndefined()
    expect(byKey(row({ meta: meta({ subagents: 3 }) })).extras).toBe('3 subagents')
  })

  it('shows a cost only when there is one', () => {
    const g = byKey(
      row({
        meta: meta({
          cost: { usd: 293.9551507500002, linesAdded: 9828, linesRemoved: 570, durationMs: 1 },
        }),
      }),
    )
    expect(g.cost).toBe('$293.96 · +9,828/−570')
  })

  it('omits a group entirely rather than drawing a placeholder in it', () => {
    // An agent row with no transcript behind it: no cwd, no size, no mtime.
    const groups = factGroups(
      { cwd: null, cwdExact: true, sizeBytes: null, modifiedAt: null, meta: NO_META },
      NOW,
    )
    expect(groups).toEqual([])
  })
})

describe('promptLine', () => {
  it('is null when the host published none', () => {
    expect(promptLine(NO_META)).toBeNull()
  })

  it('collapses a prompt to one line', () => {
    expect(promptLine(meta({ lastPrompt: ' fix\n  the\tthing ' }))).toBe('fix the thing')
  })

  it('caps a prompt the host did not cut', () => {
    const out = promptLine(meta({ lastPrompt: 'x'.repeat(400) }))
    expect(out).not.toBeNull()
    expect(out?.length).toBe(160)
    expect(out?.endsWith('…')).toBe(true)
  })

  // ── redaction ───────────────────────────────────────────────────────────
  //
  // This is the SECOND layer. The host redacts before the prompt is written
  // to disk, which is the layer that matters — the file is what an attacker
  // would read. These cases are here so that a snapshot written by an older
  // host script, or by a future one that loses a pattern, still cannot put a
  // recognisable credential on the page.

  it.each([
    ['github pat', 'push with github_pat_11ABCDEFG0aaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbb now'],
    ['classic pat', 'use ghp_abcdefghij1234567890ABCDEFGHIJ please'],
    ['anthropic key', 'key is sk-ant-api03-AbCdEf0123456789_xyz ok'],
    ['openai key', 'key is sk-proj0123456789abcdefghij ok'],
    ['aws access key', 'creds AKIAIOSFODNN7EXAMPLE and'],
    ['slack token', 'bot xoxb-1234567890-abcdefghij here'],
    ['google key', `maps AIza${'b'.repeat(35)} end`],
    [
      'jwt',
      'bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U done',
    ],
    ['url password', 'connect postgres://user:hunter2seekrit@pg:5432/app'],
    ['auth header', 'send Authorization: Bearer abc123def456ghi789 with it'],
    [
      'private key',
      '-----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXkt -----END OPENSSH PRIVATE KEY----- done',
    ],
  ])('redacts a %s', (_name, prompt) => {
    const out = promptLine(meta({ lastPrompt: prompt })) ?? ''
    expect(out).toContain('[redacted]')
    for (const shape of [
      'github_pat_',
      'ghp_',
      'sk-ant-',
      'sk-proj',
      'AKIA',
      'xoxb-',
      'AIza',
      'eyJhbGci',
      'hunter2seekrit',
      'abc123def456ghi789',
      'BEGIN OPENSSH PRIVATE KEY',
    ]) {
      expect(out).not.toContain(shape)
    }
  })

  it('leaves ordinary prose exactly as it is', () => {
    const p = 'i’m getting lot of out of memory alerts, can u check'
    expect(promptLine(meta({ lastPrompt: p }))).toBe(p)
  })

  it('redacts before it truncates', () => {
    // A token placed so that a cut-first implementation would leave its head
    // standing in the visible part of the line.
    const p = `${'a '.repeat(70)}ghp_abcdefghij1234567890ABCDEFGHIJ tail`
    const out = promptLine(meta({ lastPrompt: p })) ?? ''
    expect(out).not.toContain('ghp_')
  })
})

describe('the time group across the hydration boundary', () => {
  // A relative reading that ticks every second differs between the server's
  // render and the browser's, and React throws the whole tree away when it
  // does. The bottom of the idle scale is therefore a flat band, the same
  // mechanism `lib/format`'s `since` uses for the same reason.
  it('reports a just-written transcript as a band, not as seconds', () => {
    const at = (ms: number) =>
      factGroups(row({ modifiedAt: NOW - ms, meta: meta({ spanMs: 4 * 86_400_000 }) }), NOW).find(
        (g) => g.key === 'time',
      )?.text
    expect(at(1_000)).toBe('4d · idle <1m')
    expect(at(30_000)).toBe(at(1_000))
    expect(at(44_000)).toBe(at(1_000))
    expect(at(120_000)).toBe('4d · idle 2m')
  })

  it('does not report a negative idle when the clocks disagree', () => {
    const g = factGroups(row({ modifiedAt: NOW + 5_000, meta: NO_META }), NOW).find(
      (x) => x.key === 'time',
    )
    expect(g?.text).toBe('idle <1m')
  })
})

/* ── the process half of the line ─────────────────────────────────────────
   These readings arrived when the Sessions board was folded into the roster,
   and the whole point of folding rather than deleting that board was that
   none of them was lost. A `live` block is present on exactly the rows with
   a process behind them — one of the forty-nine on this box — so every case
   here is also a case about the forty-eight that have none. */

const live = (over: Partial<LiveFacts> = {}): LiveFacts => ({
  startedAt: NOW - 3 * 3_600_000,
  lastActivityAt: NOW - 9 * 60_000,
  cpuMs: 407_000,
  rssBytes: 587_202_560,
  ...over,
})

describe('a row with a process behind it', () => {
  it('groups the process into one fact instead of three', () => {
    expect(byKey(row({ live: live() })).proc).toBe('up 3h · 560 MB · 6m 47s cpu')
  })

  it('reads the session’s own clock rather than the transcript’s mtime', () => {
    // Both clocks are there and they disagree: the file was written a minute
    // ago, the session last said something nine minutes ago. Drawing both is
    // two idle readings on one line, which is the repetition the grouping
    // exists to remove — so the better clock wins and the other is dropped.
    const g = byKey(
      row({ modifiedAt: NOW - 60_000, live: live(), meta: meta({ spanMs: 4 * 86_400_000 }) }),
    )
    expect(g.time).toBe('4d · last seen 9m')
    expect(g.time).not.toContain('idle')
  })

  it('leaves every row without one on the transcript’s own clock', () => {
    const g = byKey(row({ meta: meta({ spanMs: 4 * 86_400_000 }) }))
    expect(g.time).toBe('4d · idle 1m')
    expect(g.proc).toBeUndefined()
  })

  it('omits a figure the snapshot did not carry rather than drawing a zero', () => {
    expect(byKey(row({ live: live({ rssBytes: null, cpuMs: null }) })).proc).toBe('up 3h')
    // And a block with nothing measurable in it draws no group at all — the
    // same rule the counts follow, applied to the process.
    expect(
      byKey(row({ live: live({ startedAt: null, rssBytes: null, cpuMs: null }) })).proc,
    ).toBeUndefined()
  })
})

describe('every reading measured from now sits in a band', () => {
  // The live row is the one this matters on: it is pinned to the top of the
  // board and it was written to seconds ago, so it is permanently inside the
  // window where `span` would be counting seconds and the browser would
  // disagree with the server about what it said.
  const timeOf = (r: RowShape): string | undefined =>
    factGroups(r, NOW).find((g) => g.key === 'time')?.text

  it('flattens the seconds a connected session would tick through', () => {
    const at = (msAgo: number) => timeOf(row({ live: live({ lastActivityAt: NOW - msAgo }) }))
    expect(at(3_000)).toBe('last seen <1m')
    expect(at(44_000)).toBe(at(3_000))
    // The 45–90s window, where `span` alone would still be printing seconds.
    expect(at(46_000)).toBe('last seen 1m')
    expect(at(89_000)).toBe(at(46_000))
    expect(at(120_000)).toBe('last seen 2m')
  })

  it('flattens the same window on the idle reading it was always on', () => {
    const at = (msAgo: number) => timeOf(row({ modifiedAt: NOW - msAgo }))
    expect(at(46_000)).toBe('idle 1m')
    expect(at(89_000)).toBe(at(46_000))
  })

  it('flattens the process uptime, which is measured from now as well', () => {
    const upAt = (msAgo: number) =>
      byKey(row({ live: live({ startedAt: NOW - msAgo, rssBytes: null, cpuMs: null }) })).proc
    expect(upAt(10_000)).toBe('up <1m')
    expect(upAt(60_000)).toBe('up 1m')
    expect(upAt(3 * 3_600_000)).toBe('up 3h')
  })
})
