// A node's Claude page, its boards: remote control, sign-in, the machine, and the update.

import { Link } from '@tanstack/react-router'
import { Ago, Until } from '../../../../components/ago'
import { NodeCommandButton } from '../../../../components/node-command'
import { EMPTY, FOOT, MONO } from '../../../../components/tokens'
import { Board, Chip, Facts } from '../../../../components/viz'
import type { NodeClaudeData } from '../../../../lib/dashboard/node-claude'
import { DASH, num, since, text } from '../../../../lib/format'
import { linkWords } from '../../../../lib/node-link'
import type { NodeRow } from '../../../../lib/repo/nodes'
import type { ClaudeFacts } from './claude'

export function RemoteControlBoard({ f }: { f: ClaudeFacts }) {
  const { node, c, v, alive, envId, startedAgo } = f
  return (
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
                  {c.detail !== null && <span className="text-subdued"> — {c.detail}</span>}
                  {c.last_line !== null && (
                    <span className="text-subdued"> · last line: {c.last_line}</span>
                  )}
                </span>
              ),
            },
            { k: 'Environment', v: <span className={MONO}>{text(envId)}</span> },
            { k: 'Spawn mode', v: text(c.server.spawn_mode) },
            {
              k: 'Capacity',
              v: `${num(alive.length)} / ${c.server.max_sessions === null ? DASH : num(c.server.max_sessions)}`,
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
            { k: 'Last exit', v: text(c.last_exit) },
            { k: 'Runs as', v: <span className={MONO}>{text(c.user)}</span> },
            {
              k: 'Working dir',
              v: (
                <span>
                  <span className={MONO}>{text(c.workdir)}</span>
                  {c.workdir_via !== null && (
                    <span className="text-subdued"> · {c.workdir_via}</span>
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
                  {c.install_method !== null && (
                    <span className="text-subdued"> · {c.install_method}</span>
                  )}
                </span>
              ),
            },
            { k: 'Default model', v: <span className={MONO}>{text(c.settings.model)}</span> },
            { k: 'Effort', v: text(c.settings.effort_level) },
          ]}
        />
      )}
      <p className={FOOT}>
        The environment id is what a phone connects to, minted per server start — the link in the
        header carries it, so a restart changes the link. The server's own output is in{' '}
        <span className={MONO}>{c?.log ?? 'logs\\claude-rc.log'}</span> on the node; the tray menu
        opens it.
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
  )
}

export function SignInBoard({ f }: { f: ClaudeFacts }) {
  const { c, refreshAt } = f
  return (
    <Board title="Sign-in" span={6}>
      {c === null ? (
        <p className={EMPTY}>Nothing reported.</p>
      ) : c.credentials.store === 'keychain' ? (
        <p className={EMPTY}>
          The login is in the macOS Keychain, where the CLI keeps it on a Mac. Its dates are not
          readable without a prompt on the machine, so there is no clock here; the server connecting
          is the proof the login works.
        </p>
      ) : !c.credentials.present ? (
        <p className={EMPTY}>
          No credentials file in <span className={MONO}>{text(c.home)}</span>. Nobody has run{' '}
          <span className={MONO}>claude</span> and logged in as {text(c.user)} on this machine, so
          Remote Control cannot connect.
        </p>
      ) : (
        <>
          <Facts
            list
            rows={[
              { k: 'Plan', v: text(c.credentials.subscription_type) },
              {
                k: 'Rate limit tier',
                v: <span className={MONO}>{text(c.credentials.rate_limit_tier)}</span>,
              },
              {
                k: 'Access token',
                v:
                  c.credentials.expires_at === null ? (
                    DASH
                  ) : (
                    <Until at={c.credentials.expires_at} />
                  ),
              },
              {
                k: 'Refresh token',
                v: refreshAt === null ? DASH : <Until at={refreshAt} />,
              },
              { k: 'Profile', v: <span className={MONO}>{text(c.home)}</span> },
            ]}
          />
          <p className={FOOT}>
            Same two clocks as the box's: the access token refreshes itself, the <b>refresh</b>{' '}
            token running out is the date to act on. The fix is on the machine: open a terminal as{' '}
            {text(c.user)}, run <span className={MONO}>claude</span>,{' '}
            <span className={MONO}>/login</span>, then the restart control here. Only the plan and
            the two dates leave the node; the tokens do not.
          </p>
        </>
      )}
    </Board>
  )
}

export function MachineBoard({ f }: { f: ClaudeFacts }) {
  const { node, status } = f
  return (
    <Board title="Machine" span={6}>
      <Facts
        list
        rows={[
          { k: 'Hostname', v: <span className={MONO}>{node.hostname}</span> },
          {
            k: 'Runs',
            v: `${status?.os_name || node.os}${status?.os_version ? ` · ${status.os_version}` : ''}`,
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
                : status.awake_hold
                  ? 'held awake'
                  : status.policy.awake_hold
                    ? `hold OFF${status.hold_error !== null ? ` — ${status.hold_error}` : ''}`
                    : 'may sleep (policy)',
          },
          {
            k: 'Link',
            v: linkWords(node),
          },
        ]}
      />
      <p className={FOOT}>
        Whether Claude runs here at all, and whether the machine is held awake, are its policy on{' '}
        <Link to="/settings" search={{ tab: 'machines' }}>
          Settings › Machines
        </Link>
        , with the rest of the machine: what it is, whether it answers, and whether the box trusts
        it.
      </p>
    </Board>
  )
}

/** The row a control sits on, under a board's facts. */
const CONTROL = 'flex flex-wrap items-center gap-3 border-hairline border-t pt-3'

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
  const method = claude?.install_method ?? null
  const last = claude?.last_update ?? null
  const running = claude?.server.version ?? null
  const installed = claude?.cli_version ?? null
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
        <span
          className={`w-full text-[0.75rem] ${last.ok ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          last update <Ago at={last.at} />:{' '}
          {last.from !== null && last.to !== null && last.from !== last.to
            ? `${last.from} → ${last.to} · `
            : ''}
          {last.detail}
        </span>
      )}
    </div>
  )
}
