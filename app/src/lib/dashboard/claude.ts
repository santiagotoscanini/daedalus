// The box's Claude tab (System › Claude, loaded by
// modules/system/data/claude.ts): Remote Control, the sessions on it, and the
// CLI underneath. Its subject is not something the box serves to the house —
// it is the thing that maintains the box.
//
// Three sources, and the split between them is the interesting part:
//
//   the controller  Remote Control and every session on it. The controller
//                   runs the server as the operator's `daedalus-claude-rc`
//                   user unit (nix/stacks/daedalus/controller.nix):
//                   `claude.status` answers its state, pid, banner (version,
//                   environment id, spawn mode, ceiling), the live sessions,
//                   the login's dates and scopes and the model settings, and
//                   `claude.restart` is the restart. `claude.roster` is the
//                   roster (every transcript on disk, the background agents,
//                   the sessions it resumed, each live session's cost, the
//                   unit's accounting, the verbs' outcomes) and
//                   `claude.session` its three verbs. A controller that does
//                   not answer one of them is not running it, and the page
//                   says so rather than erroring.
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

import type { Ctx } from '../../core/ctx'
import type { ControllerClient } from '../../host/controller/client'
import type { Banner, Report, Roster, Settings } from '../../host/controller/generated'
import { ControllerError } from '../../host/controller/wire'
import { type ClaudeSession, withStats } from '../agent/roster'
import { type VersionGap, versionGap } from './github'
import { loadShotter, playwrightInstalled, type ShotterData } from './shotter'

/* ── the facts the page draws ──────────────────────────────────────────── */

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
    /** The unit's own accounting, from the roster: every session under it. */
    memoryBytes: number | null
    cpuNsec: number | null
  }
  /** What the server printed about itself at start. All-null before it has. */
  remote: Banner
  sessions: ClaudeSession[]
  /** Every session this box could still be asked about; null before a roster came. */
  roster: Roster | null
  /** The login's plan and clocks (`expires_at` moves hourly; `refresh_expires_at` ends in a re-login). */
  credentials: Report['credentials']
  settings: Settings
  /** The `claude` the controller would start: the flake's pin. */
  cli: { version: string | null }
}

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

async function events(ctx: Pick<Ctx, 'loki'>): Promise<RcEvent[]> {
  const streams = await ctx.loki.streams(EVENT_LINE, { minutes: EVENT_DAYS * 24 * 60, limit: 400 })
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
      // start. It is the same fact as the line above it, and the roster
      // already reads that file's mtime for something more useful.
      .filter((e) => !e.text.startsWith('Debug log:'))
      .sort((a, b) => b.at - a.at)
  )
}

/* ── the page ─────────────────────────────────────────────────────────── */

export type ClaudeData = {
  facts: ClaudeFacts
  /** Whether the controller answered with a report; `facts.server` says why not. */
  reporting: boolean
  /** Why there is no roster, or null while the controller hands one over. */
  rosterMissing: string | null
  /** What the controller's session could not read for the roster, one line each. */
  rosterErrors: string[]
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
  | { report: Report; state: null; detail: null }
  | { report: null; state: 'not-run' | 'no-report' | 'unreachable'; detail: string }

/** Exported for its test. */
export async function readControllerClaude(client: ControllerClient): Promise<ControllerRead> {
  try {
    const s = await client.call('claude.status')
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
        detail: 'Remote Control not run by the controller',
      }
    }
    return {
      report: null,
      state: 'unreachable',
      detail: `the controller did not answer: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

export type RosterRead = { roster: Roster; missing: null } | { roster: null; missing: string }

/**
 * A roster, or why there is none, in a line the board prints. Shared with the
 * node page, which reads its machine's the same way.
 */
export async function readRoster(
  read: () => Promise<{ roster: Roster | null }>,
  none: string,
): Promise<RosterRead> {
  try {
    const r = await read()
    return r.roster === null ? { roster: null, missing: none } : { roster: r.roster, missing: null }
  } catch (e) {
    return { roster: null, missing: e instanceof Error ? e.message : String(e) }
  }
}

function epochMs(iso: string | null): number | null {
  if (iso === null) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** Exported for its test: the controller's report and its roster, as one. */
export function mergeFacts(read: ControllerRead, roster: Roster | null): ClaudeFacts {
  const r = read.report
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
            startedAt: epochMs(r.started_at),
            restarts: r.restarts,
            memoryBytes: roster?.server?.memory_bytes ?? null,
            cpuNsec: roster?.server?.cpu_nsec ?? null,
          },
    remote: r?.server ?? {
      version: null,
      spawn_mode: null,
      max_sessions: null,
      environment_id: null,
    },
    sessions: withStats(r?.sessions ?? [], roster?.session_stats ?? []),
    roster,
    credentials: r?.credentials ?? {
      present: false,
      store: null,
      subscription_type: null,
      rate_limit_tier: null,
      expires_at: null,
      refresh_expires_at: null,
      scopes: [],
    },
    settings: r?.settings ?? { model: null, effort_level: null },
    cli: { version: r?.cli_version ?? null },
  }
}

export async function loadClaude(ctx: Pick<Ctx, 'controller' | 'loki'>): Promise<ClaudeData> {
  const [read, roster] = await Promise.all([
    readControllerClaude(ctx.controller),
    readRoster(
      () => ctx.controller.call('claude.roster'),
      'the controller’s Claude session has not reported a roster yet',
    ),
  ])

  const facts = mergeFacts(read, roster.roster)

  // What the RUNNING server said it is, in preference to what the flake
  // built. The two differ for exactly as long as it takes to restart the
  // server after a flake update, and during that window the flake's number
  // is a claim about a process that is not running.
  const installed = facts.remote.version ?? facts.cli.version

  // No cache of its own: `versionGap` already holds one, for the rate limit.
  const [gap, log, shotter, shotterGap] = await Promise.all([
    versionGap('anthropics/claude-code', installed),
    events(ctx),
    loadShotter(),
    versionGap('microsoft/playwright', playwrightInstalled()),
  ])

  return {
    facts,
    reporting: read.report !== null,
    rosterMissing: roster.missing,
    rosterErrors: roster.roster?.errors ?? [],
    events: log,
    drops: log.filter((e) => e.kind === 'drop').length,
    gap,
    shotter,
    shotterGap,
  }
}

// ⚠ Nothing in this module may be imported as a VALUE by a component.
//
// It reaches the controller socket and Loki through node, and Vite's dev
// transform hands the browser a stub that throws the moment its named
// exports are destructured — at module evaluation, before any of it is
// called. So one value import from a view drags this whole file into the
// client graph and the page dies on hydration with the SSR markup already
// painted, which is the most confusing shape a failure can take: the content
// is on screen and then goes.
//
// Views import TYPES only (`import type { … }`, erased under
// verbatimModuleSyntax) and reach the data through a server function. Every
// other data module here follows the same rule (host/boundary.test.ts holds
// it for src/modules). Anything derived from this
// payload that a view wants lives beside the view, not here.
