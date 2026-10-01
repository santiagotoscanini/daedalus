import { Until } from '../../../../components/ago'
import { RosterBoard } from '../../../../components/claude/roster/board'
import { useNow } from '../../../../components/poll'
import { ServiceHead } from '../../../../components/service-head'
import { EMPTY } from '../../../../components/tokens'
import { Button } from '../../../../components/ui/button'
import { BoardGrid, Chip, Stat, StatStrip } from '../../../../components/viz'
import { withStats } from '../../../../lib/agent/roster'
import type { NodeClaudeData } from '../../../../lib/dashboard/node-claude'
import { DASH, duration, num, since } from '../../../../lib/format'
import { LINK_UNKNOWN } from '../../../../lib/node-link'
import type { Tone } from '../../../../lib/tone'
import { MachineBoard, RemoteControlBoard, SignInBoard } from './claude-boards'

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
    return s.tray.reporting
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

export function NodeClaudeView({ d }: { d: NodeClaudeData }) {
  // Mount-time only: the server's clock and the browser's would render two
  // different durations (components/ago.tsx).
  const now = useNow(false)
  const f = claudeFacts(d, now)
  const { node, status, c } = f

  return (
    <>
      <ClaudeHead f={f} />

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
          {status.tray.reporting
            ? 'The tray is up but has not reported Claude Code yet; give it a few seconds.'
            : status.policy.claude_remote_control
              ? `The agent is up but its tray is not reporting, which means nobody is logged on to ${node.hostname}. The server runs in the desktop session because that is where the Claude login is; a machine that reboots unattended needs automatic sign-in for it to come back.`
              : 'Claude remote control is off for this machine (Settings › Machines).'}
        </p>
      ) : null}

      <ClaudeStats f={f} />

      <BoardGrid>
        <RemoteControlBoard f={f} />

        <SignInBoard f={f} />

        <RosterBoard
          roster={d.roster}
          sessions={withStats(c?.sessions ?? [], d.roster?.session_stats ?? [])}
          node={node.id}
          holds={null}
          missing={status === null ? (d.error ?? 'not connected') : d.rosterMissing}
          errors={d.roster?.errors ?? []}
        />

        <MachineBoard f={f} />
      </BoardGrid>
    </>
  )
}

/** What the page's parts read off the node's report. */
function claudeFacts(d: NodeClaudeData, now: number | null) {
  const { node, status } = d
  const c = d.report
  const v = verdict(d)
  const alive = c?.sessions.filter((s) => s.alive) ?? []
  const running = c?.server.version ?? c?.cli_version ?? node.claude?.server_version ?? null
  const envId = c?.server.environment_id ?? null
  const startedAgo =
    now === null || c?.started_at == null ? null : (now - Date.parse(c.started_at)) / 1000
  const refreshAt = c?.credentials.refresh_expires_at ?? null
  return { d, node, status, c, v, alive, running, envId, startedAgo, refreshAt, now }
}

export type ClaudeFacts = NonNullable<ReturnType<typeof claudeFacts>>

function ClaudeHead({ f }: { f: ClaudeFacts }) {
  const { node, c, v, running, envId } = f
  return (
    <ServiceHead
      logo="/icon-claude.svg"
      name="Claude Code"
      version={running}
      versionNote={
        c?.server.version != null
          ? "printed at start by the node's remote-control server"
          : c?.cli_version != null
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
          v: c?.cli_version ?? null,
          note: 'the installed command; Update Claude Code below is what moves it',
        },
      ]}
      lede={
        <>
          The Remote Control server on {node.hostname}, run by the agent's tray in the user's own
          session with that user's Claude login — the way this box runs its own. Everything here is
          what the agent last reported up its link to the controller
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
  )
}

function ClaudeStats({ f }: { f: ClaudeFacts }) {
  const { node, status, c, v, alive, startedAgo, refreshAt, now } = f
  return (
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
        sub={c?.server.max_sessions == null ? 'alive now' : `of ${num(c.server.max_sessions)}`}
        title="Session processes alive on the node right now."
      />
      <Stat
        label="Agent"
        value={status?.version ?? node.agentVersion}
        sub={
          status === null
            ? 'last known'
            : status.awake_hold
              ? 'held awake'
              : status.policy.awake_hold
                ? 'hold OFF'
                : 'may sleep'
        }
        tone={status !== null && !status.awake_hold && status.policy.awake_hold ? 'bad' : undefined}
      />
      <Stat
        label="Login"
        value={
          refreshAt !== null ? (
            <Until at={refreshAt} />
          ) : c?.credentials.store === 'keychain' ? (
            'signed in'
          ) : (
            DASH
          )
        }
        tone={
          now !== null && refreshAt !== null && refreshAt - now < 6 * 86400_000 ? 'warn' : undefined
        }
        sub={
          c === null
            ? undefined
            : !c.credentials.present
              ? 'no credentials found'
              : c.credentials.store === 'keychain'
                ? 'in the Keychain; dates unread'
                : refreshAt === null
                  ? 'no expiry in the file'
                  : 'until re-login'
        }
      />
    </StatStrip>
  )
}
