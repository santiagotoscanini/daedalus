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

import { arrayOf, bool, type Decoder, nullable, num, obj, optional, str } from '../contract/decode'
import { readSnapshot } from '../contract/snapshot'
import { lokiStreams } from '../loki'
import { type VersionGap, versionGap } from './github'
import { loadShotter, type ShotterData } from './shotter'

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
  cpuMs: number | null
  rssBytes: number | null
  /** From the bridge's debug log. The only clock a session has — see below. */
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

const factsShape = obj({
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
        cpuMs: optional(nn, null),
        rssBytes: optional(nn, null),
        lastActivityAt: optional(nn, null),
        logBytes: optional(nn, null),
      }),
    ),
    [],
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
  const [gap, log, shotter] = await Promise.all([
    versionGap('anthropics/claude-code', installed),
    events(),
    loadShotter(),
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
