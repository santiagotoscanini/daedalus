import { Link } from '@tanstack/react-router'

import { withStats } from '../lib/agent/roster'
import { NO_ROSTER } from '../lib/claude-roster'
import type { NodeClaudeData } from '../lib/dashboard/node-claude'
import { DASH, duration, num, since, text, until } from '../lib/format'
import { LINK_UNKNOWN, linkWords } from '../lib/node-link'
import type { NodeRow } from '../lib/repo/nodes'
import type { Tone } from '../lib/tone'
import { RosterBoard } from './claude/roster/board'
import { NodeCommandButton } from './node-command'
import { ServiceHead } from './service-head'
import { EMPTY, FOOT, MONO } from './tokens'
import { Button } from './ui/button'
import { Board, BoardGrid, Chip, Facts, Stat, StatStrip } from './viz'

// The Claude page, for a machine that is not this box.
//
// Same page, same questions — can I connect, how many sessions, is it the
// build it should be, when does the login run out — answered from one
// source instead of three: what the machine's agent reports about the
// `claude remote-control` it supervises (agent/src/claude/), pushed up its
// link and held by the controller. The boards the box's page draws from
// Loki and the release feed are not here: the node's log stays on the node,
// and which release is current is a question for the box's own page rather
// than a second copy of the same feed.
//
// The two verbs at the foot are a pair and are NOT interchangeable. Update
// installs a new CLI and interrupts nothing — a session keeps the binary it
// started on and takes the new one at its next start. Restart is what moves
// the running server onto it, and it ENDS every session the server spawned;
// the roster below is where a session comes back from, by Resume where the
// machine offers one (its roster says why not where it does not).
//
// The one thing to know about a node, said once at the top when it applies:
// the server runs in the user's DESKTOP session, because that is where the
// Claude login lives. Nobody logged on means no tray, no report, and no
// server — and the page says so rather than reading as broken.

type Verdict = { label: string; tone: Tone }

function verdict(d: NodeClaudeData): Verdict {
  const s = d.status
  if (s === null) return { label: 'not connected', tone: 'muted' }
  // The report when there is one, else the status document's summary.
  const c = d.report ?? s.claude
  if (c === null) {
    return s.trayReporting
      ? { label: 'no report yet', tone: 'muted' }
      : { label: 'nobody logged on', tone: 'muted' }
  }
  switch (c.state) {
    case 'running':
      return { label: 'running', tone: 'ok' }
    case 'starting':
      return { label: 'starting', tone: 'warn' }
    case 'waiting':
      return { label: 'restarting', tone: 'warn' }
    case 'off':
      return { label: 'off by policy', tone: 'muted' }
    case 'not-installed':
      return { label: 'not installed', tone: 'bad' }
    default:
      return { label: c.state, tone: 'warn' }
  }
}

function ago(iso: string | null): number | null {
  return iso === null ? null : (Date.now() - Date.parse(iso)) / 1000
}

export function NodeClaudeView({ d }: { d: NodeClaudeData }) {
  const { node, status } = d
  const c = d.report
  const v = verdict(d)
  const alive = c?.sessions.filter((s) => s.alive) ?? []
  const running = c?.server.version ?? c?.cliVersion ?? node.claude?.serverVersion ?? null
  const envId = c?.server.environmentId ?? null
  const refreshIn =
    c?.credentials.refreshExpiresAt == null
      ? null
      : (c.credentials.refreshExpiresAt - Date.now()) / 1000
  const startedAgo = ago(c?.startedAt ?? null)

  return (
    <>
      <ServiceHead
        logo="/icon-claude.svg"
        name="Claude Code"
        version={running}
        versionNote={
          c?.server.version != null
            ? "printed at start by the node's remote-control server"
            : c?.cliVersion != null
              ? 'claude --version on the node'
              : 'from the controller’s summary'
        }
        verdict={v}
        compare={[
          {
            k: 'Server reports',
            v: c?.server.version ?? null,
            note: 'the running process, as its start banner said',
          },
          {
            k: 'CLI on the node',
            v: c?.cliVersion ?? null,
            note: 'the installed command; Update Claude Code below is what moves it',
          },
        ]}
        lede={
          <>
            The Remote Control server on {node.hostname}, run by the agent's tray in the user's own
            session with that user's Claude login — the way this box runs its own. Everything here
            is what the agent last reported up its link to the controller
            {node.connected === null
              ? `, ${since(node.lastSeenAgo)}; whether it is connected now is ${LINK_UNKNOWN}`
              : node.connected
                ? ''
                : `, ${since(node.lastSeenAgo)} — the machine is not connected now`}
            .
          </>
        }
        actions={
          envId === null ? (
            <Chip tone={v.tone}>{v.label}</Chip>
          ) : (
            <Button asChild variant="outline" size="sm">
              <a
                href={`https://claude.ai/code?environment=${envId}`}
                target="_blank"
                rel="noreferrer"
              >
                ↗ Open a session
              </a>
            </Button>
          )
        }
      />

      {status === null ? (
        <p className={EMPTY}>
          Nothing from {node.hostname}
          {d.error !== null && `: ${d.error}`}. The machine is asleep, off, or its agent cannot
          reach the controller; it was last heard {since(node.lastSeenAgo)}.
        </p>
      ) : c === null && status.claude !== null ? (
        <p className={EMPTY}>
          The machine's session reports Claude Code ({status.claude.state}), but the controller
          holds no full report for it: {d.reportError ?? 'it has not arrived yet'}.
        </p>
      ) : c === null ? (
        <p className={EMPTY}>
          {status.trayReporting
            ? 'The tray is up but has not reported Claude Code yet; give it a few seconds.'
            : status.policy.claudeRemoteControl
              ? `The agent is up but its tray is not reporting, which means nobody is logged on to ${node.hostname}. The server runs in the desktop session because that is where the Claude login is; a machine that reboots unattended needs automatic sign-in for it to come back.`
              : 'Claude remote control is off for this machine (Settings › Machines).'}
        </p>
      ) : null}

      <StatStrip>
        <Stat
          label="Server"
          value={c === null ? DASH : c.state}
          tone={v.tone === 'ok' ? undefined : v.tone === 'bad' ? 'bad' : undefined}
          sub={startedAgo === null ? undefined : `${duration(startedAgo)} without a restart`}
          title="The supervised claude remote-control process, as the tray sees it."
        />
        <Stat
          label="Sessions"
          value={c === null ? DASH : alive.length}
          sub={c?.server.maxSessions == null ? 'alive now' : `of ${num(c.server.maxSessions)}`}
          title="Session processes alive on the node right now."
        />
        <Stat
          label="Agent"
          value={status?.version ?? node.agentVersion}
          sub={
            status === null
              ? 'last known'
              : status.awakeHold
                ? 'held awake'
                : status.policy.awakeHold
                  ? 'hold OFF'
                  : 'may sleep'
          }
          tone={status !== null && !status.awakeHold && status.policy.awakeHold ? 'bad' : undefined}
        />
        <Stat
          label="Login"
          value={
            refreshIn !== null
              ? until(refreshIn)
              : c?.credentials.store === 'keychain'
                ? 'signed in'
                : DASH
          }
          tone={refreshIn !== null && refreshIn < 6 * 86400 ? 'warn' : undefined}
          sub={
            c === null
              ? undefined
              : !c.credentials.present
                ? 'no credentials found'
                : c.credentials.store === 'keychain'
                  ? 'in the Keychain; dates unread'
                  : refreshIn === null
                    ? 'no expiry in the file'
                    : 'until re-login'
          }
        />
      </StatStrip>

      <BoardGrid>
        <Board title="Remote control" span={6} aside={<Chip tone={v.tone}>{v.label}</Chip>}>
          {c === null ? (
            <p className={EMPTY}>Nothing reported.</p>
          ) : (
            <Facts
              list
              rows={[
                {
                  k: 'State',
                  v: (
                    <span>
                      {c.state}
                      {c.detail !== null && (
                        <span className="text-(--text-muted)"> — {c.detail}</span>
                      )}
                    </span>
                  ),
                },
                { k: 'Environment', v: <span className={MONO}>{text(envId)}</span> },
                { k: 'Spawn mode', v: text(c.server.spawnMode) },
                {
                  k: 'Capacity',
                  v: `${num(alive.length)} / ${c.server.maxSessions === null ? DASH : num(c.server.maxSessions)}`,
                },
                {
                  k: 'Process',
                  v:
                    c.pid === null ? (
                      DASH
                    ) : (
                      <span className={MONO}>
                        pid {String(c.pid)}
                        {startedAgo !== null && ` · ${since(startedAgo)}`}
                      </span>
                    ),
                },
                { k: 'Restarts', v: `${num(c.restarts)} since the tray came up` },
                { k: 'Last exit', v: text(c.lastExit) },
                { k: 'Runs as', v: <span className={MONO}>{text(c.user)}</span> },
                {
                  k: 'Working dir',
                  v: (
                    <span>
                      <span className={MONO}>{text(c.workdir)}</span>
                      {c.workdirVia !== null && (
                        <span className="text-(--text-muted)"> · {c.workdirVia}</span>
                      )}
                    </span>
                  ),
                },
                {
                  k: 'Command',
                  v: (
                    <span>
                      <span className={MONO}>{text(c.path)}</span>
                      {/* How Claude Code got here, as the agent read it off
                          the path (agent/src/claude/cli.rs) — it decides
                          which verb updates it. */}
                      {c.installMethod !== null && (
                        <span className="text-(--text-muted)"> · {c.installMethod}</span>
                      )}
                    </span>
                  ),
                },
                { k: 'Default model', v: <span className={MONO}>{text(c.settings.model)}</span> },
                { k: 'Effort', v: text(c.settings.effortLevel) },
              ]}
            />
          )}
          <p className={FOOT}>
            The environment id is what a phone connects to, minted per server start — the link in
            the header carries it, so a restart changes the link. The server's own output is in{' '}
            <span className={MONO}>{c?.log ?? 'logs\\claude-rc.log'}</span> on the node; the tray
            menu opens it.
          </p>
          <UpdateControl node={node} claude={c} />
          <div className={CONTROL}>
            <NodeCommandButton
              id={node.id}
              command="claude_restart"
              label="Restart the server"
              note="ends every session on the node; a fresh server starts"
            />
          </div>
        </Board>

        <Board title="Sign-in" span={6}>
          {c === null ? (
            <p className={EMPTY}>Nothing reported.</p>
          ) : c.credentials.store === 'keychain' ? (
            <p className={EMPTY}>
              The login is in the macOS Keychain, where the CLI keeps it on a Mac. Its dates are not
              readable without a prompt on the machine, so there is no clock here; the server
              connecting is the proof the login works.
            </p>
          ) : !c.credentials.present ? (
            <p className={EMPTY}>
              No credentials file in <span className={MONO}>{text(c.home)}</span>. Nobody has run{' '}
              <span className={MONO}>claude</span> and logged in as {text(c.user)} on this machine,
              so Remote Control cannot connect.
            </p>
          ) : (
            <>
              <Facts
                list
                rows={[
                  { k: 'Plan', v: text(c.credentials.subscriptionType) },
                  {
                    k: 'Rate limit tier',
                    v: <span className={MONO}>{text(c.credentials.rateLimitTier)}</span>,
                  },
                  {
                    k: 'Access token',
                    v:
                      c.credentials.expiresAt === null
                        ? DASH
                        : until((c.credentials.expiresAt - Date.now()) / 1000),
                  },
                  { k: 'Refresh token', v: refreshIn === null ? DASH : until(refreshIn) },
                  { k: 'Profile', v: <span className={MONO}>{text(c.home)}</span> },
                ]}
              />
              <p className={FOOT}>
                Same two clocks as the box's: the access token refreshes itself, the <b>refresh</b>{' '}
                token running out is the date to act on. The fix is on the machine: open a terminal
                as {text(c.user)}, run <span className={MONO}>claude</span>,{' '}
                <span className={MONO}>/login</span>, then the restart control here. Only the plan
                and the two dates leave the node; the tokens do not.
              </p>
            </>
          )}
        </Board>

        <RosterBoard
          roster={d.roster?.roster ?? NO_ROSTER}
          sessions={withStats(c?.sessions ?? [], d.roster?.sessionStats ?? [])}
          node={node.id}
          holds={null}
          missing={status === null ? (d.error ?? 'not connected') : d.rosterMissing}
          errors={d.roster?.errors ?? []}
        />

        <Board title="Machine" span={6}>
          <Facts
            list
            rows={[
              { k: 'Hostname', v: <span className={MONO}>{node.hostname}</span> },
              {
                k: 'Runs',
                v: `${status?.osName || node.os}${status?.osVersion ? ` · ${status.osVersion}` : ''}`,
              },
              {
                k: 'Agent',
                v: <span className={MONO}>{status?.version ?? node.agentVersion}</span>,
              },
              {
                k: 'Awake',
                v:
                  status === null
                    ? DASH
                    : status.awakeHold
                      ? 'held awake'
                      : status.policy.awakeHold
                        ? `hold OFF${status.holdError !== null ? ` — ${status.holdError}` : ''}`
                        : 'may sleep (policy)',
              },
              {
                k: 'Link',
                v: linkWords(node),
              },
            ]}
          />
          <p className={FOOT}>
            Whether Claude runs here at all, and whether the machine is held awake, are its policy
            on{' '}
            <Link to="/settings" search={{ tab: 'machines' }}>
              Settings › Machines
            </Link>
            , with the rest of the machine: what it is, whether it answers, and whether the box
            trusts it.
          </p>
        </Board>
      </BoardGrid>
    </>
  )
}

/** The row a control sits on, under a board's facts. */
const CONTROL =
  'mt-[0.7rem] flex flex-wrap items-center gap-3 border-(--border-soft) border-t pt-[0.75rem]'

/**
 * Update Claude Code on this machine.
 *
 * The session runs it, which is the only thing that can: the CLI's login
 * lives in the user's profile and the service — session 0 on Windows, root
 * on macOS — cannot see it. `claude update` is the supported verb for a
 * native or npm install and needs no elevation; for one a package manager
 * owns it is a safe no-op that reports "Claude is up to date!", and those
 * upgrade themselves through the env var the session sets on the server it
 * spawns. A machine-wide install under an administrator's path is the case
 * nothing here can do, and the method beside Command above is what says so.
 *
 * Nothing is interrupted. The new CLI installs beside the running one and
 * takes effect the next time it starts, so after this the page shows the
 * server still on the old version. Restart is what closes that gap, and it
 * ends every session here.
 */
function UpdateControl({ node, claude }: { node: NodeRow; claude: NodeClaudeData['report'] }) {
  const method = claude?.installMethod ?? null
  const last = claude?.lastUpdate ?? null
  const running = claude?.server.version ?? null
  const installed = claude?.cliVersion ?? null
  // The gap this button is for: the CLI on disk has moved and the server is
  // still on what it started with. Only stated when both are known — two
  // nulls are not a disagreement.
  const stale = running !== null && installed !== null && running !== installed

  return (
    <div className={CONTROL}>
      <NodeCommandButton
        id={node.id}
        command="claude_update"
        label="Update Claude Code"
        note={
          stale
            ? `the CLI on disk is ${text(installed)} and the server is still running ${text(running)} — Restart is what closes that`
            : `runs \`claude update\` on the machine${method === null ? '' : ` (${method})`}; the new version takes effect the next time the CLI starts`
        }
      />
      {/* What the last run actually did, in its own words. The outcomes
          worth reading are the quiet ones — "Claude is up to date!" from a
          package-manager install, a refusal from a managed one — and none
          of them shows up in a version number. */}
      {last !== null && (
        <span className={`w-full text-[0.74rem] ${last.ok ? 'text-(--dim)' : 'text-destructive'}`}>
          last update {since((Date.now() - Date.parse(last.at)) / 1000)}:{' '}
          {last.from !== null && last.to !== null && last.from !== last.to
            ? `${last.from} → ${last.to} · `
            : ''}
          {last.detail}
        </span>
      )}
    </div>
  )
}
