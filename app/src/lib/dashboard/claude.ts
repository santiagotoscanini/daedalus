// The box's Claude tab (System › Claude, loaded by
// modules/system/data/claude.ts): Remote Control, the sessions on it, and the
// CLI underneath. Its subject is not something the box serves to the house —
// it is the thing that maintains the box.
//
// Four sources, and the split between them is the interesting part:
//
//   the controller  Remote Control itself: the controller runs it as the
//                   operator's `daedalus-claude-rc` user unit
//                   (nix/stacks/daedalus/controller.nix) and `claude.status`
//                   answers its state, pid, banner (version, environment id,
//                   spawn mode, ceiling), the live sessions, the login's
//                   dates and the model settings. `claude.restart` is the
//                   restart. A controller that does not offer
//                   `claude.remote_control` is not running it, and the page
//                   says so rather than erroring.
//   the snapshot    What the controller does not carry: the roster (every
//                   transcript on disk, the background agents, the sessions
//                   this box started as `claude-session@` units), the unit's
//                   memory and CPU, each live session's CPU, RSS and bridge
//                   log, and the login's scopes. See
//                   nix/stacks/daedalus/host/claude-snapshot.sh.
//   Loki            Everything that HAPPENED: sessions starting, the
//                   connection dropping, the reconnect that followed. The
//                   unit's log file is shipped with those lines and nothing
//                   else records them.
//   GitHub          Whether the version running is the current one, and what
//                   is in the releases between.
//
// ── why the Loki query is anchored the way it is ──────────────────────────
//
// Every remote session writes its stream-json transcript to the server's
// output, so `{unit="daedalus-claude-rc.service"}` is mostly JSON with a few
// dozen human lines scattered through it (the shipper drops the tool results
// and the status-box repaint, controller.nix). The regex below matches the
// CLI's own `[HH:MM:SS]` event prefix, which the transcript lines cannot have
// — a substring filter would have to guess at what a transcript never
// contains, and be wrong the first time somebody pasted a log into a session.

import { readSnapshot } from '../../host/contract/snapshot'
import type { ControllerClient } from '../../host/controller/client'
import { ControllerError } from '../../host/controller/wire'
import { env } from '../../host/env'
import { lokiStreams } from '../../host/loki'
import type { NodeClaude } from '../agent/status'
import { NO_META } from '../claude-meta'
import { type ClaudeRoster, NO_ROSTER } from '../claude-roster'
import { arrayOf, bool, type Decoder, nullable, num, obj, optional, str } from '../contract/decode'
import { type VersionGap, versionGap } from './github'
import { loadShotter, playwrightInstalled, type ShotterData } from './shotter'

/* ── the facts the page draws ──────────────────────────────────────────── */

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
  /** `busy` while the session is working. */
  status: string | null
  cpuMs: number | null
  rssBytes: number | null
  /**
   * The later of two clocks: the session file's own `updatedAt` /
   * `statusUpdatedAt` (the controller's report), and the bridge debug log's
   * mtime (the snapshot). Both, because a session with no `cse_…` (a console
   * or tmux-resumed one) has no debug log, and the bridge log moves on
   * traffic the session file does not record.
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
  /** Remote Control as the controller reports it. */
  server: {
    /**
     * The agent's word — not-installed | off | starting | running | waiting |
     * stopped — or, when there is no report: `not-run` (the controller does
     * not run Remote Control), `no-report` (it does, and no report is fresh)
     * or `unreachable` (the controller did not answer).
     */
    state: string
    /** Why, in a line, when the state has a reason. */
    detail: string | null
    pid: number | null
    /** Milliseconds since the epoch. */
    startedAt: number | null
    /** Starts after the first, since the controller came up. */
    restarts: number | null
    /** The unit's own accounting, from the snapshot: every session under it. */
    memoryBytes: number | null
    cpuNsec: number | null
  }
  /** What the server printed about itself at start. All-null before it has. */
  remote: {
    version: string | null
    spawnMode: string | null
    maxSessions: number | null
    environmentId: string | null
  }
  sessions: ClaudeSession[]
  /** Every session this box could still be asked about (the snapshot). */
  roster: ClaudeRoster
  credentials: {
    present: boolean
    subscriptionType: string | null
    rateLimitTier: string | null
    /** The access token's clock. Moves hourly; nothing to watch. */
    expiresAt: number | null
    /** The one that ends in a re-login. */
    refreshExpiresAt: number | null
    /** From the snapshot, which reads the credentials file's scopes alone. */
    scopes: string[]
  }
  settings: { model: string | null; effortLevel: string | null }
  /** The `claude` the controller would start: the flake's pin. */
  cli: { version: string | null }
}

/* ── the snapshot ─────────────────────────────────────────────────────── */

type SessionStat = {
  pid: number
  cpuMs: number | null
  rssBytes: number | null
  logBytes: number | null
  bridgeAt: number | null
}

type SnapshotFacts = {
  unit: { memoryBytes: number | null; cpuNsec: number | null }
  sessionStats: SessionStat[]
  roster: ClaudeRoster
  scopes: string[]
}

const NO_SNAPSHOT: SnapshotFacts = {
  unit: { memoryBytes: null, cpuNsec: null },
  sessionStats: [],
  roster: NO_ROSTER,
  scopes: [],
}

const ns: Decoder<string | null> = nullable(str)
const nn: Decoder<number | null> = nullable(num)

/**
 * Exported for its test, which is the only other caller.
 *
 * Every key optional, with a real empty fallback: between the rebuild that
 * installs a new host script and its next timer tick the file on disk is the
 * previous script's, and a decoder that required the new keys would blank the
 * roster for that minute.
 */
export const factsShape = obj({
  unit: optional(
    obj({ memoryBytes: optional(nn, null), cpuNsec: optional(nn, null) }),
    NO_SNAPSHOT.unit,
  ),
  sessionStats: optional(
    arrayOf(
      obj({
        pid: num,
        cpuMs: optional(nn, null),
        rssBytes: optional(nn, null),
        logBytes: optional(nn, null),
        bridgeAt: optional(nn, null),
      }),
    ),
    [],
  ),
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
            // Optional throughout, like `roster`: a row with no `meta` reads
            // as NOT KNOWN on every field — never zero — which is exactly
            // `NO_META`'s shape.
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
      // `claude-session@` units. Optional like everything else here; an
      // empty list is the safe reading — no row then claims a kill it cannot
      // perform.
      managedIds: optional(arrayOf(str), []),
    }),
    NO_ROSTER,
  ),
  scopes: optional(arrayOf(str), []),
})

/* ── the events ───────────────────────────────────────────────────────── */

type RcEventKind = 'session' | 'drop' | 'reconnect' | 'refresh' | 'other'

export type RcEvent = { at: number; kind: RcEventKind; text: string }

/**
 * The CLI's own event prefix, and the whole reason this query is affordable.
 * See the header: the alternative is reading every remote session's
 * transcript back out of Loki to find a dozen lines.
 */
const EVENT_LINE = '{unit="daedalus-claude-rc.service"} |~ `^\\[[0-9]{2}:[0-9]{2}:[0-9]{2}\\] `'

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
  /** False = the snapshot has never been written: no roster, no accounting. */
  available: boolean
  /** The producing timer has stopped keeping its one-minute promise. */
  stale: boolean
  ageMs: number | null
  /** Whether the controller answered with a report; `facts.server` says why not. */
  reporting: boolean
  events: RcEvent[]
  /** Drops in the window, which is the honest measure of "is it reachable". */
  drops: number
  gap: VersionGap
  /** The sessions' eyes — the shotter lab's ledger and archive. */
  shotter: ShotterData
  /** Playwright's gap, for the Shotter tab — the one dependency under `shot`. */
  shotterGap: VersionGap
}

type ControllerRead =
  | { report: NodeClaude; state: null; detail: null }
  | { report: null; state: 'not-run' | 'no-report' | 'unreachable'; detail: string }

/** Exported for its test. */
export async function readControllerClaude(client: ControllerClient): Promise<ControllerRead> {
  try {
    const s = await client.claudeStatus()
    if (s.report !== null) return { report: s.report, state: null, detail: null }
    return {
      report: null,
      state: s.wanted ? 'no-report' : 'not-run',
      detail: s.wanted
        ? 'the controller runs Remote Control, and no report from it is fresh'
        : 'Remote Control is off in the controller’s policy',
    }
  } catch (e) {
    if (e instanceof ControllerError && e.code === 'unsupported') {
      return {
        report: null,
        state: 'not-run',
        detail: 'Remote Control not run by the controller yet',
      }
    }
    return {
      report: null,
      state: 'unreachable',
      detail: `the controller did not answer: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

function epochMs(iso: string | null): number | null {
  if (iso === null) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** Exported for its test: the controller's report and the snapshot, as one. */
export function mergeFacts(read: ControllerRead, snap: SnapshotFacts): ClaudeFacts {
  const r = read.report
  const stats = new Map(snap.sessionStats.map((s) => [s.pid, s]))
  const sessions: ClaudeSession[] = (r?.sessions ?? []).map((s) => {
    const st = s.alive ? stats.get(s.pid) : undefined
    const clocks = [s.lastActivityAt, st?.bridgeAt ?? null].filter((c) => c !== null)
    return {
      pid: s.pid,
      transcriptId: s.transcriptId,
      remoteId: s.remoteId,
      cwd: s.cwd,
      name: s.name,
      kind: s.kind,
      entrypoint: s.entrypoint,
      version: s.version,
      startedAt: s.startedAt,
      alive: s.alive,
      status: s.status,
      cpuMs: st?.cpuMs ?? null,
      rssBytes: st?.rssBytes ?? null,
      lastActivityAt: clocks.length === 0 ? null : Math.max(...clocks),
      logBytes: st?.logBytes ?? null,
    }
  })
  return {
    server:
      r === null
        ? {
            state: read.state ?? 'unreachable',
            detail: read.detail,
            pid: null,
            startedAt: null,
            restarts: null,
            memoryBytes: null,
            cpuNsec: null,
          }
        : {
            state: r.state,
            detail: r.detail,
            pid: r.pid,
            startedAt: epochMs(r.startedAt),
            restarts: r.restarts,
            memoryBytes: snap.unit.memoryBytes,
            cpuNsec: snap.unit.cpuNsec,
          },
    remote: r?.server ?? { version: null, spawnMode: null, maxSessions: null, environmentId: null },
    sessions,
    roster: snap.roster,
    credentials: {
      present: r?.credentials.present ?? false,
      subscriptionType: r?.credentials.subscriptionType ?? null,
      rateLimitTier: r?.credentials.rateLimitTier ?? null,
      expiresAt: r?.credentials.expiresAt ?? null,
      refreshExpiresAt: r?.credentials.refreshExpiresAt ?? null,
      scopes: snap.scopes,
    },
    settings: r?.settings ?? { model: null, effortLevel: null },
    cli: { version: r?.cliVersion ?? null },
  }
}

export async function loadClaude(ctx: { controller: ControllerClient }): Promise<ClaudeData> {
  const [snapshot, read] = await Promise.all([
    readSnapshot({
      path: env.get('CLAUDE_FACTS_PATH'),
      decoder: factsShape,
      fallback: NO_SNAPSHOT,
      acceptVersions: [1],
      // Written every minute; the convention here is three intervals, so one
      // missed run is jitter and three is a producer that has stopped.
      maxAgeMs: 3 * 60_000,
    }),
    readControllerClaude(ctx.controller),
  ])

  const facts = mergeFacts(read, snapshot.data)

  // What the RUNNING server said it is, in preference to what the flake
  // built. The two differ for exactly as long as it takes to restart the
  // server after a flake update, and during that window the flake's number
  // is a claim about a process that is not running.
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
    reporting: read.report !== null,
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
// other data module here follows the same rule (host/boundary.test.ts holds
// it for src/modules). Anything derived from this
// payload that a view wants lives beside the view, not here.
