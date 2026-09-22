import { Link, useRouter } from '@tanstack/react-router'
import { useState, useTransition } from 'react'

import { agentHasClaude, type NodeClaudeSession } from '../lib/agent/status'
import { cn } from '../lib/cn'
import type { NodeClaudeData } from '../lib/dashboard/node-claude'
import { DASH, duration, num, since, text, until } from '../lib/format'
import { errorText } from '../lib/redact'
import type { NodeRow } from '../lib/repo/nodes'
import type { Tone } from '../lib/tone'
import { requestClaudeRestartFn } from '../server/nodes'
import { ServiceHead } from './service-head'
import { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE } from './tokens'
import { Button } from './ui/button'
import { Board, BoardGrid, Chip, Facts, Stat, StatStrip } from './viz'

// The Claude page, for a machine that is not this box.
//
// Same page, same questions — can I connect, how many sessions, is it the
// build it should be, when does the login run out — answered from one
// source instead of three: the agent's status page on the node, which
// carries what its tray reports about the `claude remote-control` it
// supervises (agent/src/claude.rs). The boards the box's page draws from
// Loki and the release feed are not here: the node's log stays on the node
// and Claude Code updates itself there.
//
// The one thing to know about a node, said once at the top when it applies:
// the server runs in the user's DESKTOP session, because that is where the
// Claude login lives. Nobody logged on means no tray, no report, and no
// server — and the page says so rather than reading as broken.

const OS_MARK: Record<string, { src: string; invert: boolean }> = {
  windows: { src: '/icon-windows.svg', invert: false },
  macos: { src: '/icon-apple.svg', invert: true },
  linux: { src: '/icon-linux.svg', invert: true },
}

/** The machine picker: this box, then every approved node. Drawn only once there is a node. */
export function MachinePicker({ nodes, active }: { nodes: NodeRow[]; active: string | null }) {
  if (nodes.length === 0) return null
  const pill = (selected: boolean) =>
    cn(
      'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[0.8rem] transition-colors',
      selected
        ? 'border-primary bg-primary/10 text-foreground'
        : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
    )
  return (
    <nav aria-label="Machine" className="mb-4 flex flex-wrap items-center gap-2">
      <Link to="/claude" search={{}} className={pill(active === null)}>
        <img src="/icon-nixos.webp" alt="" width={14} height={14} className="size-3.5" />
        This box
      </Link>
      {nodes.map((n) => {
        const mark = OS_MARK[n.os]
        return (
          <Link
            key={n.id}
            to="/claude"
            search={{ machine: n.id }}
            className={pill(active === n.id)}
          >
            {mark !== undefined && (
              <img
                src={mark.src}
                alt=""
                width={14}
                height={14}
                className={cn('size-3.5', mark.invert && 'dark:invert')}
              />
            )}
            {n.name}
            {n.claude !== null && n.claude.sessions > 0 && (
              <span className={`${MONO} text-[0.7rem] text-(--dim)`}>{n.claude.sessions}</span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}

type Verdict = { label: string; tone: Tone }

function verdict(d: NodeClaudeData): Verdict {
  const s = d.status
  if (s === null) return { label: 'agent not answering', tone: 'bad' }
  // The report when the box could read it, else the open page's summary.
  const c = d.report ?? s.claude
  if (c === null) {
    if (!agentHasClaude(s.version)) return { label: `agent ${s.version} is too old`, tone: 'warn' }
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
        name={`Claude Code on ${node.name}`}
        version={running}
        versionNote={
          c?.server.version != null
            ? "printed at start by the node's remote-control server"
            : c?.cliVersion != null
              ? 'claude --version on the node'
              : 'from the last hello'
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
            note: 'the installed command; Claude Code updates itself there',
          },
        ]}
        lede={
          <>
            The Remote Control server on {node.hostname}, run by the agent's tray in the user's own
            session with that user's Claude login — the way this box runs its own. Everything here
            is what the tray reports through the agent's status page, read just now.
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
          The agent on {node.hostname} did not answer{d.error !== null && `: ${d.error}`}. The
          machine is asleep, off, or on a network this box cannot reach; the last hello was{' '}
          {since(node.lastSeenAgo)}.
        </p>
      ) : c === null && status.claude !== null ? (
        <p className={EMPTY}>
          The agent answers, and its tray reports Claude Code ({status.claude.state}), but the full
          report was not read: {d.reportError ?? 'no reason given'}. The open page carries only a
          summary; the rest needs the token the box hands an approved node on its next hello.
        </p>
      ) : c === null ? (
        <p className={EMPTY}>
          {!agentHasClaude(status.version)
            ? `The agent on ${node.hostname} is ${status.version}; running and reporting Claude Code arrived in agent 0.4.0. Check for updates on System › Machines — the agent installs it by itself.`
            : status.trayReporting
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
              ? 'from the last hello'
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
                { k: 'Command', v: <span className={MONO}>{text(c.path)}</span> },
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
          <RestartControl node={node} />
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

        <Board
          title="Sessions"
          span={12}
          aside={
            c !== null && (
              <span className={NOTE}>
                {num(alive.length)} alive · {num(c.sessions.length - alive.length)} stale
              </span>
            )
          }
        >
          {c === null || c.sessions.length === 0 ? (
            <p className={EMPTY}>No session files on the node.</p>
          ) : (
            <ul className={LIST}>
              {c.sessions.map((s) => (
                <SessionRow key={`${String(s.pid)}-${s.transcriptId ?? ''}`} s={s} />
              ))}
            </ul>
          )}
          <p className={FOOT}>
            One file per session process in the user's Claude profile, as on the box. A stale row is
            a file whose process has ended; the CLI clears them in its own time. Resuming or
            stopping a session on a node is not wired yet — that needs a command channel the hello
            does not carry.
          </p>
        </Board>

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
              { k: 'Last hello', v: since(node.lastSeenAgo) },
            ]}
          />
          <p className={FOOT}>
            Whether Claude runs here at all, and whether the machine is held awake, are its policy
            on{' '}
            <Link to="/settings" search={{ tab: 'machines' }}>
              Settings › Machines
            </Link>
            ; the rest of the machine is on{' '}
            <Link to="/c/$category" params={{ category: 'system' }} search={{ tab: 'machines' }}>
              System › Machines
            </Link>
            .
          </p>
        </Board>
      </BoardGrid>
    </>
  )
}

function SessionRow({ s }: { s: NodeClaudeSession }) {
  const started = s.startedAt === null ? null : (Date.now() - s.startedAt) / 1000
  const last = s.lastActivityAt === null ? null : (Date.now() - s.lastActivityAt) / 1000
  const facts = [
    s.kind,
    s.version,
    s.remoteId === null ? null : s.remoteId.slice(0, 18),
    started === null ? null : `started ${since(started)}`,
    last === null || !s.alive ? null : `active ${since(last)}`,
  ].filter((x): x is string => x !== null)
  return (
    <li className={ROW}>
      <div className={`${ROW_MAIN} flex items-baseline gap-2`}>
        <span className={`${MONO} font-medium`}>
          {s.name ?? s.transcriptId?.slice(0, 8) ?? DASH}
        </span>
        <span className={`${NOTE} truncate`}>{s.cwd ?? ''}</span>
      </div>
      <div className={`${ROW_SIDE} flex items-center gap-2`}>
        <Chip tone={s.alive ? (s.status === 'busy' ? 'warn' : 'ok') : 'muted'}>
          {s.alive ? (s.status ?? 'alive') : 'ended'}
        </Chip>
        <span className="truncate">{facts.join(' · ')}</span>
      </div>
    </li>
  )
}

/**
 * Restart the node's server. Not the box's two-step arming: the cost is the
 * node's sessions, which are named right here, and the request rides the
 * next hello rather than a bridge — so "queued" is the honest state, and
 * the page's next load shows what happened.
 */
function RestartControl({ node }: { node: NodeRow }) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="mt-[0.7rem] flex flex-wrap items-center gap-3 border-(--border-soft) border-t pt-[0.75rem]">
      <Button
        size="sm"
        variant="outline"
        disabled={busy || node.claudeRestartRequested}
        onClick={() => {
          setError(null)
          start(async () => {
            try {
              await requestClaudeRestartFn({ data: { id: node.id } })
              await router.invalidate()
            } catch (e) {
              setError(errorText(e))
            }
          })
        }}
      >
        {node.claudeRestartRequested ? 'Restart queued' : 'Restart the server'}
      </Button>
      <span className="text-[0.74rem] text-(--dim)">
        {node.claudeRestartRequested
          ? 'rides the next hello, within a minute; every session on the node ends'
          : 'ends every session on the node; the tray starts a fresh server'}
      </span>
      {error !== null && <span className="text-[0.78rem] text-destructive">{error}</span>}
    </div>
  )
}
