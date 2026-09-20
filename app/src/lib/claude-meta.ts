// What a session card says about a transcript, beyond what it is.
//
// Pure, and in `lib/` for the same reason claude-roster.ts is: the module
// that reads the host snapshot reaches node:fs, so a component cannot import
// a value from it. Everything a row needs derived lives here and is tested
// here.
//
// ── the source, and what it is honest about ───────────────────────────────
//
// `stacks/daedalus/host/claude-snapshot.sh` makes one awk pass over each
// transcript whose (mtime, size) moved and publishes the counts below. Two
// of its decisions are load-bearing here and are the reason this file does
// not simply print what it is given:
//
//   `exchanges` is user records that are NOT tool results. The raw record
//   count is four times larger and would read as four times the conversation.
//
//   Anything the CLI did not record is `null`, never `0`. `cost-state` is in
//   3 of 49 transcripts on this box, and `subagents` is only a number when
//   the `isSidechain` marker was written at all. A card that says "0
//   subagents" when the truth is "this CLI version never wrote them" is worse
//   than a card that says nothing, so this file's whole convention is:
//   `null` and `0` both render as absence, and only a positive count speaks.
//
// ── why the prompt is redacted again here ─────────────────────────────────
//
// It is already redacted on the host, before it is written to disk — that is
// the layer that matters, because the file is the thing an attacker would
// read. This is the second pass, the same two-layer shape the build log has
// had since it existed (see lib/redact.ts's own header): the host filters as
// it writes, and everything leaving this server passes through the patterns
// again. It costs nothing and it means a snapshot written by an older host
// script, or by a future one that loses a pattern, still cannot put a
// recognisable credential on the page.
//
// Neither layer is a guarantee. Redaction of prose recognises credentials by
// shape; a password or a passphrase has no shape. The host header says so at
// length and this comment will not pretend otherwise.
//
// What actually pays for carrying a line of conversation at all is the FILE
// MODE, not the filter. The transcript tree holds pasted keys, tokens and the
// output of `sops -d`, so the snapshot behind the page was tightened to 0600
// in an owner-only directory before the first character of it was written:
// operator and root, no build, no other container, no other user. A secret
// pasted inside those 160 characters does land in that file — that is the
// trade, taken deliberately, and the mode is what makes it payable. The page
// itself no longer argues any of this; it shows the line and this is the
// record of why it is allowed to.

import { bytes, ms } from './format'
import { redactSecrets } from './redact'

/** Per-transcript facts from the host's scan. `null` = not recorded. */
export type TranscriptMeta = {
  /**
   * Which version of the host scanner produced this. `0` is the block the
   * host publishes when it has nothing — every field null, no scan behind it.
   */
  scanVersion: number
  /** User turns that are not tool results — what the operator actually sent. */
  exchanges: number | null
  replies: number | null
  thinking: number | null
  images: number | null
  /** Files the operator attached. Not the CLI's own injected attachments. */
  attached: number | null
  /** Null where the CLI never wrote the `isSidechain` marker at all. */
  subagents: number | null
  /** Last timestamp minus first: the span it was open across, not work time. */
  spanMs: number | null
  branch: string | null
  cliVersion: string | null
  /** One line, redacted and cut to ~160 chars, host-side. Usually absent. */
  lastPrompt: string | null
  /** Present in a small minority of transcripts. Never synthesised. */
  cost: {
    usd: number | null
    linesAdded: number | null
    linesRemoved: number | null
    durationMs: number | null
  } | null
}

export const NO_META: TranscriptMeta = {
  scanVersion: 0,
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

/**
 * The extra credential shapes a PROMPT can carry that a build log cannot.
 *
 * `lib/redact.ts` was written for build output and covers what a build
 * prints: GitHub tokens, JWTs, registry auth, URL userinfo. A prompt is
 * whatever the operator pasted, so it can carry the API keys of services this
 * box never builds against. These are appended rather than added to
 * `redact.ts` because that module has a linear-time contract and a test suite
 * built around the build path, and widening it for this page's sake is a
 * change to every log on the dashboard.
 *
 * Each is anchored at a literal prefix and bounded, so none can backtrack.
 */
const PROMPT_PATTERNS: RegExp[] = [
  /sk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
]

/** How much of a prompt a row shows. The host already cut it; this is the cap
    that holds if it ever did not. */
const PROMPT_MAX = 160

/**
 * The prompt a row may display, or null.
 *
 * Whitespace collapses because the host's own collapse is not something this
 * side should depend on, and a prompt with a newline in it would break the
 * row's single line. Redaction runs BEFORE the cut for the reason the host
 * gives: cutting first can leave the head of a token standing where the
 * pattern would have taken all of it.
 */
export function promptLine(meta: TranscriptMeta): string | null {
  const raw = meta.lastPrompt
  if (raw === null) return null
  const flat = raw.replace(/\s+/g, ' ').trim()
  if (flat === '') return null
  let out = redactSecrets(flat)
  for (const re of PROMPT_PATTERNS) out = out.replace(re, '[redacted]')
  out = out.trim()
  if (out === '') return null
  return out.length > PROMPT_MAX ? `${out.slice(0, PROMPT_MAX - 1)}…` : out
}

/**
 * One group of facts that answer the same question.
 *
 * Grouping rather than listing is the point: a directory and a branch are one
 * fact about where, a count and a size are one fact about how big, and a span
 * and an idle time are one story about when. Listing them as six separate
 * readings is what made the row a column of numbers nobody read.
 *
 * `icon` names the one picture the group is allowed, and most groups get
 * none. The rule the operator set is that an icon replaces a word — never
 * decorates one — so only the three groups whose picture is unambiguous at
 * 12px carry one, and everything else keeps its word. A row that needed a
 * legend would have too many.
 */
export type FactIcon = 'where' | 'size' | 'time'

export type FactGroup = {
  key: string
  icon: FactIcon | null
  text: string
  /** The long form, for `title`. Null where the text is already complete. */
  detail: string | null
  /** True for the groups a phone drops. The first three always survive. */
  secondary: boolean
}

/**
 * The facts a row has only while a process is behind it.
 *
 * These came off the Sessions board, which drew the same live sessions this
 * board draws as its `alive` rows — two lists of one population, and a reader
 * had to hold both to answer "what is running". They are per-session facts, so
 * they belong on the session's row; the server-wide summary above the boards
 * (`N of 32`, drops, the login clock) is a different thing and stays.
 */
export type LiveFacts = {
  /** When the PROCESS started — not when the conversation did. */
  startedAt: number | null
  /**
   * The later of the session file's own clock and the bridge debug log's
   * mtime. A better reading than the transcript's mtime and it replaces it
   * on a live row: two idle readings on one line is the repetition this
   * whole grouping exists to remove.
   */
  lastActivityAt: number | null
  cpuMs: number | null
  rssBytes: number | null
}

/** What the row already knows without the scan. */
export type RowShape = {
  cwd: string | null
  cwdExact: boolean
  sizeBytes: number | null
  /** Last write to the transcript. */
  modifiedAt: number | null
  meta: TranscriptMeta
  /** Null for every row with no process behind it, which is most of them. */
  live?: LiveFacts | null
}

const n = (v: number | null): string => v?.toLocaleString('en-US') ?? ''

/** A positive count, or nothing. Zero is absence here — see the header. */
const counted = (v: number | null, word: string): string | null =>
  v !== null && v > 0 ? `${n(v)} ${word}` : null

/**
 * A duration in the shortest unit that still reads. Deliberately not
 * `lib/format`'s `since`/`duration`: those take seconds and are shaped for a
 * clock reading, and what this line wants is the same rough magnitude in both
 * halves of the time group so the two can be compared at a glance.
 */
function span(msValue: number): string {
  const s = Math.max(0, Math.round(msValue / 1000))
  if (s < 90) return `${String(s)}s`
  const m = Math.round(s / 60)
  if (m < 90) return `${String(m)}m`
  const h = Math.round(m / 60)
  if (h < 48) return `${String(h)}h`
  return `${String(Math.round(h / 24))}d`
}

/**
 * A distance FROM NOW — the only kind of reading on this line that moves
 * while nobody touches it, and therefore the only one that can differ between
 * the server's render and the browser's. A page whose text differs across that
 * boundary is thrown away and re-rendered on the client; React calls it a
 * hydration mismatch and the console says so.
 *
 * `span` above ticks every second below 90s, which is fine for its own job —
 * a span is the difference between two fixed timestamps and does not move at
 * all — and fatal here. So the bottom of this scale is two flat bands: under
 * 45 seconds reads as `<1m`, the same wording and the same threshold
 * `lib/format`'s `since` uses, and the 45–90s gap where `span` would still be
 * counting seconds reads as the `1m` it is about to become. Above 90s the
 * units are coarse enough that a render and its hydration land in the same
 * one.
 *
 * Both bands earn their keep on a LIVE row rather than on a transcript: a
 * session being worked on right now was written to seconds ago, and it is
 * pinned to the top of the board.
 */
function ago(msValue: number): string {
  if (msValue < 45_000) return '<1m'
  if (msValue < 90_000) return '1m'
  return span(msValue)
}

/** How long ago the transcript was last written. */
function idle(msValue: number): string {
  return `idle ${ago(msValue)}`
}

/**
 * The same reading for a row with a process behind it, taken from the
 * session's own clock rather than the file's — the later of the session
 * file's `updatedAt` and the bridge log's mtime, which is strictly the better
 * of the two. The word changes with the source: `idle` is a file that has not
 * been written to, `last seen` is a session that has not said anything.
 */
function seen(msValue: number): string {
  return `last seen ${ago(msValue)}`
}

/**
 * The row's metadata line, grouped.
 *
 * Every group is omitted entirely when it has nothing to say, rather than
 * rendered with a dash: a line of placeholders is the failure mode this
 * replaces. The order is fixed — where, how big, how long, what else was in
 * it, what it cost, what it ran on, which id — because a line whose fields
 * move between rows cannot be scanned down a column.
 */
export function factGroups(row: RowShape, now: number): FactGroup[] {
  const { meta } = row
  const out: FactGroup[] = []

  // Where. The directory and the branch are one fact, and the branch is
  // meaningless without the directory, so it never appears alone.
  if (row.cwd !== null && row.cwd !== '') {
    // `?` is the existing mark for a cwd un-slugged from the project directory
    // name, where a dash inside a real directory name comes back wrong. It
    // goes on the DIRECTORY, not on the end of the group: the branch is read
    // from the file and is not in doubt, and `/etc/nixos on main?` puts the
    // doubt on the only half of the line that does not have any.
    const dir = row.cwdExact ? row.cwd : `${row.cwd}?`
    const where = meta.branch === null ? dir : `${dir} on ${meta.branch}`
    out.push({
      key: 'where',
      icon: 'where',
      text: where,
      detail: row.cwdExact ? null : `${row.cwd} — reconstructed from the project directory name`,
      secondary: false,
    })
  }

  // How big. The conversation's length and the file's size answer the same
  // question from two sides, so they share a slot.
  const size = row.sizeBytes === null ? null : bytes(row.sizeBytes)
  const turns = counted(meta.exchanges, meta.exchanges === 1 ? 'exchange' : 'exchanges')
  const big = [turns, size].filter((p) => p !== null)
  if (big.length > 0) {
    out.push({
      key: 'size',
      icon: 'size',
      text: big.join(' · '),
      detail:
        turns === null
          ? null
          : `${turns} sent, ${n(meta.replies)} replies — user turns that are not tool results`,
      secondary: false,
    })
  }

  // How long. The span it was open across and how long ago it last moved are
  // one story; either alone invites the wrong reading.
  //
  // A LIVE row's second half is "last seen", from the session's own clock,
  // and not the transcript's mtime — that clock is strictly better (it is the
  // later of the session file's `updatedAt` and the bridge log's mtime) and
  // printing both would put two idle readings a few seconds apart on one
  // line, which is exactly the repetition this grouping exists to remove.
  const live = row.live ?? null
  const clock = live?.lastActivityAt ?? null
  const parts: string[] = []
  if (meta.spanMs !== null && meta.spanMs > 0) parts.push(span(meta.spanMs))
  if (clock !== null) parts.push(seen(Math.max(0, now - clock)))
  else if (row.modifiedAt !== null) parts.push(idle(Math.max(0, now - row.modifiedAt)))
  if (parts.length > 0) {
    out.push({
      key: 'time',
      icon: 'time',
      text: parts.join(' · '),
      detail:
        clock === null
          ? 'first record to last, then how long since the last write'
          : 'first record to last, then the session’s own activity clock — the later of its file and the bridge log',
      secondary: false,
    })
  }

  // The process, where there is one. Three facts about the same subject: how
  // long this incarnation has been up, and what it is costing the box. No
  // icon — three pictures on a line is where a legend starts, and these three
  // carry their own units.
  if (live !== null) {
    const bits: string[] = []
    // `ago`, not `span`: this one is measured from now too, so a session
    // started in the last minute would tick across the hydration boundary
    // exactly as its activity clock would.
    if (live.startedAt !== null) bits.push(`up ${ago(Math.max(0, now - live.startedAt))}`)
    if (live.rssBytes !== null) bits.push(bytes(live.rssBytes))
    if (live.cpuMs !== null) bits.push(`${ms(live.cpuMs)} cpu`)
    if (bits.length > 0) {
      out.push({
        key: 'proc',
        icon: null,
        text: bits.join(' · '),
        detail: 'the session process: how long it has been running, its RSS and its CPU time',
        secondary: true,
      })
    }
  }

  // What else was in it. One slot, not four, and only what is actually there.
  const extras = [
    counted(meta.thinking, 'thinking'),
    counted(meta.images, meta.images === 1 ? 'image' : 'images'),
    counted(meta.attached, meta.attached === 1 ? 'file' : 'files'),
    // Only ever positive: the host publishes null where the CLI did not
    // record the marker, and this drops a recorded zero as well.
    counted(meta.subagents, 'subagents'),
  ].filter((p) => p !== null)
  if (extras.length > 0) {
    out.push({ key: 'extras', icon: null, text: extras.join(' · '), detail: null, secondary: true })
  }

  // What it cost. Published for a small minority of transcripts and never
  // synthesised, so this slot is absent far more often than it is present.
  if (meta.cost !== null) {
    const bits: string[] = []
    if (meta.cost.usd !== null && meta.cost.usd > 0) bits.push(`$${meta.cost.usd.toFixed(2)}`)
    const add = meta.cost.linesAdded ?? 0
    const del = meta.cost.linesRemoved ?? 0
    if (add > 0 || del > 0) bits.push(`+${n(add)}/−${n(del)}`)
    if (bits.length > 0) {
      out.push({
        key: 'cost',
        icon: null,
        text: bits.join(' · '),
        detail: 'from the transcript’s own cost-state record, which most do not carry',
        secondary: true,
      })
    }
  }

  if (meta.cliVersion !== null) {
    out.push({
      key: 'cli',
      icon: null,
      text: `v${meta.cliVersion}`,
      detail: 'the CLI version this session ran under',
      secondary: true,
    })
  }

  return out
}
