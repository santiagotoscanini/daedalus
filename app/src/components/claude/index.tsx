// The Claude page, and (re-exported) the Shotter page beside it on System.
//
// One file per board: remote-control-board, sign-in-board, connection-board,
// roster/ (the session roster — board, row, tone tables), controls/ (the
// three verbs with state machines behind them), verdicts.ts (the pure
// helpers), shared.ts (what several of them spell alike), shotter.tsx.
//
// The import rule every file here follows. Values come from server/claude —
// server functions, which are the client-safe door to the host. From host/*
// and lib/dashboard/* it is types ONLY: the modules behind them reach the
// controller socket and Loki through node, and a value import from there
// would put that in the browser bundle — see the warning at the foot of
// lib/dashboard/claude.ts. That is why the derived helpers live in
// verdicts.ts beside the view, and why each host status's idle shape is
// restated beside the control that polls it.
import type { ClaudeData } from '../../lib/dashboard/claude'
import type { VersionGap } from '../../lib/dashboard/github'
import { DASH, duration, num, text } from '../../lib/format'
import { Until } from '../ago'
import { LogBoard } from '../logs'
import { useNow } from '../poll'
import { Changelog } from '../release-notes'
import { ServiceHead } from '../service-head'
import { CAPTION, EMPTY, FOOT, MONO, NOTE } from '../tokens'
import { Button } from '../ui/button'
import { BoardGrid, Chip, Stat, StatStrip } from '../viz'
import { ConnectionBoard } from './connection-board'
import { RemoteControlBoard } from './remote-control-board'
import { RosterBoard } from './roster/board'
import { SignInBoard } from './sign-in-board'
import { liveSessions, type Verdict, versionVerdict } from './verdicts'

export { ShotterView } from './shotter'

// The Claude page.
//
// Its subject is the only one on this dashboard that is not a service the
// house consumes — it is the session the operator is probably holding while
// reading any other page here, which is also why the page has a duty the
// others do not: it has to stay legible when the thing it describes is the
// thing that has broken. Nothing on it depends on Remote Control being up.
//
// The four headline numbers are chosen to be the four questions actually
// asked of it, in order: can I connect, how many of me are already on, has
// the link been dropping, and how long until the login expires. The last is
// the one nothing else on this box would ever tell you.

export function ClaudeView({ data }: { data: ClaudeData }) {
  const { facts } = data
  const live = liveSessions(facts).length
  const verdict = versionVerdict(data)

  return (
    <>
      <ClaudeHead data={data} verdict={verdict} />
      <ControllerNotice data={data} />
      <ClaudeStats data={data} live={live} />

      <BoardGrid>
        <RemoteControlBoard data={data} live={live} />

        {/* Paired by height rather than by subject: Remote control and its
            link's history are the two long boards, Sign-in and the releases
            the two short ones. Side by side, each pair shares a bottom edge
            instead of leaving half a board of empty glass. */}
        <ConnectionBoard events={data.events} />

        <SignInBoard credentials={facts.credentials} reporting={data.reporting} />

        {/* Beside Sign-in rather than across the page: a version list is a
            column of short rows that never needed 12. */}
        <ClaudeReleases gap={data.gap} note={verdict.note} />

        {/* The reason to open this page, so it sits where the attention goes
            rather than at the foot. It is the page's only list of sessions:
            the connected ones are its `alive` rows. */}
        <RosterBoard
          roster={facts.roster}
          sessions={facts.sessions}
          node={null}
          holds={facts.cli.version}
          missing={data.rosterMissing}
          errors={data.rosterErrors}
        />

        <RemoteControlLogs />
      </BoardGrid>
    </>
  )
}

function ClaudeHead({ data, verdict }: { data: ClaudeData; verdict: Verdict }) {
  const { facts } = data
  const up = facts.server.state === 'running'
  const envId = facts.remote.environment_id
  return (
    <ServiceHead
      logo="/icon-claude.svg"
      name="Claude Code"
      version={facts.remote.version ?? facts.cli.version}
      versionNote={
        facts.remote.version === null ? 'from the flake' : 'reported by the remote-control server'
      }
      verdict={{ label: verdict.label, tone: verdict.tone }}
      compare={[
        {
          k: 'Server reports',
          v: facts.remote.version,
          note: 'printed at start by the running process, not the pin',
        },
        {
          k: 'Flake holds',
          v: facts.cli.version,
          note:
            facts.remote.version !== null && facts.remote.version !== facts.cli.version
              ? 'a rebuild landed this and nothing restarted onto it'
              : 'what nixos-rebuild built',
        },
        {
          k: 'Latest release',
          v: data.gap.latest,
          note: 'Update Claude Code, on the Remote control board, is what moves the pin',
        },
      ]}
      lede={
        <>
          The always-on Remote Control server, which the controller runs as the operator's{' '}
          <span className={MONO}>daedalus-claude-rc</span> unit. A session on this box can be
          started from claude.ai/code or a phone at any time. It has no health endpoint of its own,
          so every number here is the controller's report or the server's log.
        </>
      }
      actions={
        envId === null ? (
          <Chip tone={up || !data.reporting ? 'muted' : 'bad'}>
            {up ? 'no environment yet' : data.reporting ? 'not running' : 'no report'}
          </Chip>
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

/* Said once, at the top: with no report from the controller the boards about
   the server are empty, and the reason is the one line worth reading. */
function ControllerNotice({ data }: { data: ClaudeData }) {
  if (data.reporting) return null
  return <p className={EMPTY}>{data.facts.server.detail}.</p>
}

function ClaudeStats({ data, live }: { data: ClaudeData; live: number }) {
  const { facts } = data
  const up = facts.server.state === 'running'
  // Mount-time only: the server's clock and the browser's would render two
  // different durations (components/ago.tsx).
  const now = useNow(false)
  const refreshAt = facts.credentials.refresh_expires_at
  return (
    <StatStrip>
      <Stat
        label="Server"
        value={up ? 'up' : text(facts.server.state)}
        tone={up ? undefined : data.reporting ? 'bad' : 'muted'}
        sub={
          facts.server.startedAt === null || now === null
            ? undefined
            : `${duration((now - facts.server.startedAt) / 1000)} without a restart`
        }
        title="The controller's report on its daedalus-claude-rc unit."
      />
      <Stat
        label="Sessions"
        value={live}
        sub={
          facts.remote.max_sessions === null
            ? 'connected now'
            : `of ${num(facts.remote.max_sessions)}`
        }
        title="Session processes alive right now, not sessions this server has ever served."
      />
      <Stat
        label="Drops"
        value={data.drops}
        // A drop is not a fault: the server reconnects by itself and the
        // session survives. It is a fault only if it is CLIMBING, which is
        // what a count over a fortnight is for.
        tone={data.drops > 40 ? 'warn' : undefined}
        sub="reconnect attempts, 14d"
      />
      <Stat
        label="Login"
        value={refreshAt === null ? DASH : <Until at={refreshAt} />}
        // Six days out is the point at which the fix (SSH in, `/login`,
        // restart the unit) stops being a thing you can do at leisure.
        tone={
          now !== null && refreshAt !== null && refreshAt - now < 6 * 86400_000 ? 'warn' : undefined
        }
        sub={
          refreshAt !== null
            ? 'until re-login'
            : data.reporting
              ? 'no credentials found'
              : 'no report'
        }
      />
    </StatStrip>
  )
}

function ClaudeReleases({ gap, note }: { gap: VersionGap; note: string }) {
  return (
    <Changelog
      gap={gap}
      span={6}
      aside={<span className={NOTE}>anthropics/claude-code</span>}
      foot={
        <>
          <p className={FOOT}>
            The store binary cannot update itself — it is sealed with{' '}
            <span className={MONO}>DISABLE_UPDATES</span>, because{' '}
            <span className={MONO}>claude update</span> would leave it alone and build a second,
            native install nothing reverts. <b>Update Claude Code</b> above is the supported move:
            it pins the release manifest in the engine, signature-checked, and rebuilds onto it. The
            weekly <span className={MONO}>flake-autoupgrade.timer</span> gets there on its own
            whenever nixpkgs does. A rebuild restarts the controller, not the server: the server is
            a user unit of its own, so a switch never ends a session — and so it keeps running the
            old binary until a reboot or the restart above.
          </p>
          {note !== '' && <p className={CAPTION}>{note}</p>}
        </>
      }
    />
  )
}

function RemoteControlLogs() {
  return (
    <LogBoard
      source={{ unit: 'daedalus-claude-rc.service' }}
      title="Remote Control logs"
      foot={
        <p className={FOOT}>
          The server's log file, which is mostly not events: every remote session writes its
          stream-json transcript to the same output, so a search here is searching transcripts as
          well as the server's own lines. The shipper drops what tools returned and the status box's
          repaint; the file on the box keeps everything. The Connection board above is the filtered
          view: the server's lines are the ones prefixed <span className={MONO}>[HH:MM:SS]</span>,
          which a transcript line cannot be.
        </p>
      }
    />
  )
}
