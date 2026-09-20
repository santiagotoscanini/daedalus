// The Claude page: Remote Control, the sessions on it, and the CLI underneath.
//
// This is the one page in the app whose subject is not something the box
// serves to the house — it is the thing that maintains the box, which is why
// it sits at the foot of the rail rather than eighth in a list of subjects.
//
// Three sources, and the split between them is the interesting part:
//
//   the snapshot   Everything that is TRUE NOW: is the unit up, which
//                  sessions are connected, when does the login expire. None
//                  of it is scrapeable — `claude remote-control` publishes no
//                  health endpoint at all (platform/claude-rc.nix), and the
//                  session roster is a directory of files in the operator's
//                  home. See stacks/daedalus/host/claude-snapshot.sh.
//   Loki           Everything that HAPPENED: sessions starting, the
//                  connection dropping, the reconnect that followed. The unit
//                  logs those and nothing else records them.
//   GitHub         Whether the version running is the current one, and what
//                  is in the releases between.
//
// ── why the Loki query is anchored the way it is ──────────────────────────
//
// Every remote session writes its full stream-json transcript to this unit's
// stdout, so `{unit="claude-remote-control.service"}` is overwhelmingly
// megabytes of JSON with a few dozen human lines scattered through it. The
// regex below matches the CLI's own `[HH:MM:SS]` event prefix, which the
// transcript lines cannot have — a substring filter would have to guess at
// what a transcript never contains, and be wrong the first time somebody
// pasted a log into a session.

import { readSnapshot } from '../../host/contract/snapshot'
import { lokiStreams } from '../../host/loki'
import { NO_META } from '../claude-meta'
import { type ClaudeRoster, NO_ROSTER } from '../claude-roster'
import { arrayOf, bool, type Decoder, nullable, num, obj, optional, str } from '../contract/decode'
import { type VersionGap, versionGap } from './github'
import { loadShotter, playwrightInstalled, type ShotterData } from './shotter'

/* ── the snapshot ─────────────────────────────────────────────────────── */

export type ClaudeSession = {
  pid: number
  /** The uuid the transcript on disk is filed under. */
  transcriptId: string | null
  /** `cse_…` — the id claude.ai shows for this session. Null once it exits. */
  remoteId: string | null
  cwd: string | null
  /** The short label the CLI derives, e.g. `nixos-ac`. */
  name: string | null
  kind: string | null
  entrypoint: string | null
  version: string | null
  startedAt: number | null
  /** The pid is alive AND is still the process this file was written for. */
  alive: boolean
  /** `busy` while the session is working. Absent from an older snapshot. */
  status: string | null
  cpuMs: number | null
  rssBytes: number | null
  /**
   * The later of two clocks: the session file's own `updatedAt` /
   * `statusUpdatedAt`, and the bridge debug log's mtime. The file used to be
   * written once at start, which left every session with no `cse_…` — every
   * console and tmux-resumed one — reporting no activity at all. CLI 2.1.260
   * keeps that file current as the session runs, so both populations have a
   * reading now and the later of the two wins.
   *
   * On a live row this REPLACES the transcript's own mtime rather than
   * sitting beside it (see the `time` group in lib/claude-meta.ts): it is the
   * better clock, and two idle readings seconds apart on one line is noise.
   * An idle reading of hours is ordinary — it is a session waiting, not a
   * session broken.
   */
  lastActivityAt: number | null
  logBytes: number | null
}

export type ClaudeFacts = {
  service: {
    activeState: string
    subState: string
    result: string
    restarts: number | null
    memoryBytes: number | null
    cpuNsec: number | null
    activeSince: number | null
  }
  /** What the server printed about itself at start. All-null before it has. */
  remote: {
    version: string | null
    spawnMode: string | null
    maxSessions: number | null
    environmentId: string | null
  }
  sessions: ClaudeSession[]
  /**
   * Every session this box could still be asked about, as against `sessions`
   * above, which is only what is connected right now. Absent from any
   * snapshot written before this key existed — which is what the `optional`
   * in the decoder is for: the rollout window is one timer tick wide and the
   * page has to render through it.
   */
  roster: ClaudeRoster
  credentials: {
    present: boolean
    subscriptionType: string | null
    rateLimitTier: string | null
    /** The access token's clock. Moves hourly; nothing to watch. */
    expiresAt: number | null
    /** The one that ends in a re-login. */
    refreshExpiresAt: number | null
    scopes: string[]
  }
  settings: { model: string | null; effortLevel: string | null }
  cli: { version: string | null; storePath: string | null }
}

const NO_FACTS: ClaudeFacts = {
  service: {
    activeState: 'unknown',
    subState: '',
    result: '',
    restarts: null,
    memoryBytes: null,
    cpuNsec: null,
    activeSince: null,
  },
  remote: { version: null, spawnMode: null, maxSessions: null, environmentId: null },
  sessions: [],
  roster: NO_ROSTER,
  credentials: {
    present: false,
    subscriptionType: null,
    rateLimitTier: null,
    expiresAt: null,
    refreshExpiresAt: null,
    scopes: [],
  },
  settings: { model: null, effortLevel: null },
  cli: { version: null, storePath: null },
}

const ns: Decoder<string | null> = nullable(str)
const nn: Decoder<number | null> = nullable(num)

/**
 * Exported for its test, which is the only other caller.
 *
 * Worth a test of its own rather than one through `loadClaude`: the property
 * that matters is tolerance of a snapshot the CURRENT host script did not
 * write — every rollout of a new key has a window where the file on disk is
 * the previous script's — and reaching that through the loader would mean
 * standing up GitHub, Loki and the shotter archive to assert one default.
 */
export const factsShape = obj({
  service: optional(
    obj({
      activeState: optional(str, 'unknown'),
      subState: optional(str, ''),
      result: optional(str, ''),
      restarts: optional(nn, null),
      memoryBytes: optional(nn, null),
      cpuNsec: optional(nn, null),
      activeSince: optional(nn, null),
    }),
    NO_FACTS.service,
  ),
  remote: optional(
    obj({
      version: optional(ns, null),
      spawnMode: optional(ns, null),
      maxSessions: optional(nn, null),
      environmentId: optional(ns, null),
    }),
    NO_FACTS.remote,
  ),
  sessions: optional(
    arrayOf(
      obj({
        pid: num,
        transcriptId: optional(ns, null),
        remoteId: optional(ns, null),
        cwd: optional(ns, null),
        name: optional(ns, null),
        kind: optional(ns, null),
        entrypoint: optional(ns, null),
        version: optional(ns, null),
        startedAt: optional(nn, null),
        alive: optional(bool, false),
        status: optional(ns, null),
        cpuMs: optional(nn, null),
        rssBytes: optional(nn, null),
        lastActivityAt: optional(nn, null),
        logBytes: optional(nn, null),
      }),
    ),
    [],
  ),
  // Every field optional, the whole block optional, and the fallback a real
  // empty roster: this key did not exist one snapshot ago, and the page has
  // to draw correctly against a file written by the previous script.
  roster: optional(
    obj({
      agentsAvailable: optional(bool, false),
      agents: optional(
        arrayOf(
          obj({
            id: optional(ns, null),
            sessionId: optional(ns, null),
            pid: optional(nn, null),
            kind: optional(ns, null),
            state: optional(ns, null),
            status: optional(ns, null),
            name: optional(ns, null),
            cwd: optional(ns, null),
            startedAt: optional(nn, null),
          }),
        ),
        [],
      ),
      transcripts: optional(
        arrayOf(
          obj({
            // The one required field on the row: it is the join key and the
            // thing `--resume` would be handed. A row without it is not a
            // row with a hole, it is a row about nothing.
            id: str,
            project: optional(str, ''),
            cwd: optional(str, ''),
            cwdExact: optional(bool, false),
            title: optional(ns, null),
            titleSource: optional(ns, null),
            startedAt: optional(nn, null),
            modifiedAt: optional(num, 0),
            sizeBytes: optional(num, 0),
            // Every field optional and the block itself optional, for the
            // same reason `roster` is: a snapshot written before the host
            // scanned anything has no `meta` at all, and the correct reading
            // of that is NOT KNOWN on every field — never zero. `NO_META` is
            // exactly that shape, so the page draws a pre-scan row as a row
            // with nothing extra to say rather than as a silent session.
            meta: optional(
              obj({
                scanVersion: optional(num, 0),
                exchanges: optional(nn, null),
                replies: optional(nn, null),
                thinking: optional(nn, null),
                images: optional(nn, null),
                attached: optional(nn, null),
                subagents: optional(nn, null),
                spanMs: optional(nn, null),
                branch: optional(ns, null),
                cliVersion: optional(ns, null),
                lastPrompt: optional(ns, null),
                cost: optional(
                  nullable(
                    obj({
                      usd: optional(nn, null),
                      linesAdded: optional(nn, null),
                      linesRemoved: optional(nn, null),
                      durationMs: optional(nn, null),
                    }),
                  ),
                  null,
                ),
              }),
              NO_META,
            ),
          }),
        ),
        [],
      ),
      transcriptTotal: optional(num, 0),
      emptyCount: optional(num, 0),
      // The sessions this box started, as the instance names of the active
      // `claude-session@` units. Optional like everything else here: a
      // snapshot written before the Resume button existed knows nothing about
      // them, and an empty list is the correct reading of that — no row then
      // claims a kill it cannot perform.
      managedIds: optional(arrayOf(str), []),
    }),
    NO_ROSTER,
  ),
  credentials: optional(
    obj({
      present: optional(bool, false),
      subscriptionType: optional(ns, null),
      rateLimitTier: optional(ns, null),
      expiresAt: optional(nn, null),
      refreshExpiresAt: optional(nn, null),
      scopes: optional(arrayOf(str), []),
    }),
    NO_FACTS.credentials,
  ),
  settings: optional(
    obj({ model: optional(ns, null), effortLevel: optional(ns, null) }),
    NO_FACTS.settings,
  ),
  cli: optional(obj({ version: optional(ns, null), storePath: optional(ns, null) }), NO_FACTS.cli),
})

/* ── the events ───────────────────────────────────────────────────────── */

export type RcEventKind = 'session' | 'drop' | 'reconnect' | 'refresh' | 'other'

export type RcEvent = { at: number; kind: RcEventKind; text: string }

/**
 * The CLI's own event prefix, and the whole reason this query is affordable.
 * See the header: the alternative is reading every remote session's
 * transcript back out of Loki to find a dozen lines.
 */
const EVENT_LINE = '{unit="claude-remote-control.service"} |~ `^\\[[0-9]{2}:[0-9]{2}:[0-9]{2}\\] `'

const EVENT_DAYS = 14

function classify(text: string): RcEventKind {
  if (text.startsWith('Session started')) return 'session'
  if (text.startsWith('Connection error')) return 'drop'
  if (text.startsWith('Reconnected')) return 'reconnect'
  if (text.startsWith('Refreshing session')) return 'refresh'
  return 'other'
}

async function events(): Promise<RcEvent[]> {
  const streams = await lokiStreams(EVENT_LINE, { minutes: EVENT_DAYS * 24 * 60, limit: 400 })
  return (
    streams
      .flatMap((s) => s.values)
      .map(([nsTime, line]) => {
        // The clock in the prefix is dropped rather than parsed: it carries no
        // date, and Loki's ingest timestamp beside it already places the line.
        // Keeping both would put two times on one row that can disagree.
        const text = line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, '')
        return { at: Number(nsTime) / 1e6, kind: classify(text), text }
      })
      // The debug-log path is printed on its own line under every session
      // start. It is the same fact as the line above it, and the snapshot
      // already reads that file's mtime for something more useful.
      .filter((e) => !e.text.startsWith('Debug log:'))
      .sort((a, b) => b.at - a.at)
  )
}

/* ── the page ─────────────────────────────────────────────────────────── */

export type ClaudeData = {
  facts: ClaudeFacts
  /** False = the snapshot has never been written. Nothing below is real. */
  available: boolean
  /** The producing timer has stopped keeping its one-minute promise. */
  stale: boolean
  ageMs: number | null
  events: RcEvent[]
  /** Drops in the window, which is the honest measure of "is it reachable". */
  drops: number
  gap: VersionGap
  /** The sessions' eyes — the shotter lab's ledger and archive. */
  shotter: ShotterData
  /** Playwright's gap, for the Shotter tab — the one dependency under `shot`. */
  shotterGap: VersionGap
}

export async function loadClaude(): Promise<ClaudeData> {
  const snapshot = await readSnapshot({
    path: process.env.CLAUDE_FACTS_PATH ?? '/claude/claude.json',
    decoder: factsShape,
    fallback: NO_FACTS,
    acceptVersions: [1],
    // Written every minute; the convention here is three intervals, so one
    // missed run is jitter and three is a producer that has stopped.
    maxAgeMs: 3 * 60_000,
  })

  const facts = snapshot.data

  // What the RUNNING server said it is, in preference to what the flake
  // built. The two differ for exactly as long as it takes to restart the unit
  // after a flake update, and during that window the flake's number is a
  // claim about a process that is not running.
  const installed = facts.remote.version ?? facts.cli.version

  // No cache of its own: `versionGap` already holds one, for the rate limit.
  const [gap, log, shotter, shotterGap] = await Promise.all([
    versionGap('anthropics/claude-code', installed),
    events(),
    loadShotter(),
    versionGap('microsoft/playwright', playwrightInstalled()),
  ])

  return {
    facts,
    available: snapshot.available,
    stale: snapshot.stale,
    ageMs: snapshot.ageMs,
    events: log,
    drops: log.filter((e) => e.kind === 'drop').length,
    gap,
    shotter,
    shotterGap,
  }
}

// ⚠ Nothing in this module may be imported as a VALUE by a component.
//
// `readSnapshot` above reaches node:fs/promises, and Vite's dev transform
// hands the browser a stub that throws the moment its named exports are
// destructured — at module evaluation, before any of it is called. So one
// value import from a view drags this whole file into the client graph and
// the page dies on hydration with the SSR markup already painted, which is
// the most confusing shape a failure can take: the content is on screen and
// then goes.
//
// Views import TYPES only (`import type { … }`, erased under
// verbatimModuleSyntax) and reach the data through a server function. Every
// other data module here follows the same rule — see the top of
// components/category/gaming.tsx for the shape. Anything derived from this
// payload that a view wants lives beside the view, not here.
