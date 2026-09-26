// The Claude page, and (re-exported) the Shotter page beside it on System.
//
// One file per board: remote-control-board, sign-in-board, connection-board,
// roster/ (the session roster — board, row, tone tables), controls/ (the
// three verbs with state machines behind them), verdicts.ts (the pure
// helpers), shared.ts (what several of them spell alike), shotter.tsx.
//
// The import rule every file here follows. Values come from server/claude —
// server functions, which are the client-safe door to the host. From host/*
// and lib/dashboard/* it is types ONLY: the modules behind them read the host
// snapshot (and the bridge) through node:fs, and a value import from there
// would put that in the browser bundle — see the warning at the foot of
// lib/dashboard/claude.ts. That is why the derived helpers live in
// verdicts.ts beside the view, and why each host status's idle shape is
// restated beside the control that polls it.
import type { ClaudeData } from '../../lib/dashboard/claude'
import type { VersionGap } from '../../lib/dashboard/github'
import { DASH, duration, num, since, text, until } from '../../lib/format'
import { LogBoard } from '../logs'
import { Changelog } from '../release-notes'
import { ServiceHead } from '../service-head'
import { EMPTY, FOOT, MONO, NOTE } from '../tokens'
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
  const refreshIn =
    facts.credentials.refreshExpiresAt === null
      ? null
      : (facts.credentials.refreshExpiresAt - Date.now()) / 1000

  return (
    <>
      <ClaudeHead data={data} verdict={verdict} />
      <SnapshotNotice data={data} />
      <ClaudeStats data={data} live={live} refreshIn={refreshIn} />

      <BoardGrid>
        <RemoteControlBoard data={data} live={live} refreshIn={refreshIn} />

        {/* Sign-in comes up beside Remote control. The two are one subject —
            what this server is, and whether it can still reach Anthropic —
            and row 1 is where the page's standing facts belong. */}
        <SignInBoard credentials={facts.credentials} refreshIn={refreshIn} />

        <ConnectionBoard events={data.events} />

        {/* Beside Connection rather than across the page. The two answer the
            same question from opposite ends — is this server talking to
            Anthropic right now, and is it the build that should be — and a
            version list is a column of short rows that never needed 12. */}
        <ClaudeReleases gap={data.gap} note={verdict.note} />

        {/* The reason to open this page, so it sits where the attention goes
            rather than at the foot. It is the page's only list of sessions:
            the connected ones are its `alive` rows. */}
        <RosterBoard data={data} />

        <RemoteControlLogs />
      </BoardGrid>
    </>
  )
}

function ClaudeHead({ data, verdict }: { data: ClaudeData; verdict: Verdict }) {
  const { facts } = data
  const up = facts.service.activeState === 'active'
  const envId = facts.remote.environmentId
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
          The always-on Remote Control server. A session on this box can be started from
          claude.ai/code or a phone at any time. It has no health endpoint of its own, so every
          number here is read from the unit, the session files and this unit's journal.
        </>
      }
      actions={
        envId === null ? (
          <Chip tone={up ? 'muted' : 'bad'}>{up ? 'no environment yet' : 'not running'}</Chip>
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

/* Said once, at the top, and not repeated on every board below: when the
   snapshot has stopped the whole page is a photograph, and a reader who has
   been told that can discount all of it at once. */
function SnapshotNotice({ data }: { data: ClaudeData }) {
  if (!data.available) {
    return (
      <p className={EMPTY}>
        The host snapshot has never been written, so nothing below is a reading.{' '}
        <span className={MONO}>daedalus-claude-snapshot.service</span> is what produces it.
      </p>
    )
  }
  if (data.stale) {
    return (
      <p className={EMPTY}>
        The snapshot is <b>{since((data.ageMs ?? 0) / 1000)}</b> and its timer promises one a
        minute, so the sessions and the unit state below are a photograph rather than a reading.
      </p>
    )
  }
  return null
}

function ClaudeStats({
  data,
  live,
  refreshIn,
}: {
  data: ClaudeData
  live: number
  refreshIn: number | null
}) {
  const { facts } = data
  const up = facts.service.activeState === 'active'
  return (
    <StatStrip>
      <Stat
        label="Server"
        value={up ? 'up' : text(facts.service.activeState)}
        tone={up ? undefined : 'bad'}
        sub={
          facts.service.activeSince === null
            ? undefined
            : `${duration((Date.now() - facts.service.activeSince) / 1000)} without a restart`
        }
        title="systemd's view of claude-remote-control.service."
      />
      <Stat
        label="Sessions"
        value={live}
        sub={
          facts.remote.maxSessions === null
            ? 'connected now'
            : `of ${num(facts.remote.maxSessions)}`
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
        value={refreshIn === null ? DASH : until(refreshIn)}
        // Six days out is the point at which the fix (SSH in, `/login`,
        // restart the unit) stops being a thing you can do at leisure.
        tone={refreshIn !== null && refreshIn < 6 * 86400 ? 'warn' : undefined}
        sub={refreshIn === null ? 'no credentials found' : 'until re-login'}
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
        <p className={FOOT}>
          The store binary cannot update itself — it is sealed with{' '}
          <span className={MONO}>DISABLE_UPDATES</span>, because{' '}
          <span className={MONO}>claude update</span> would leave it alone and build a second,
          native install nothing reverts. <b>Update Claude Code</b> above is the supported move: it
          pins the release manifest in the engine, signature-checked, and rebuilds onto it. The
          weekly <span className={MONO}>flake-autoupgrade.timer</span> gets there on its own
          whenever nixpkgs does. A rebuild deliberately does NOT restart this unit onto the new
          build — it once killed its own activation doing so — so the server keeps running the old
          binary until a reboot or the controls above. {note}
        </p>
      }
    />
  )
}

function RemoteControlLogs() {
  return (
    <LogBoard
      source={{ unit: 'claude-remote-control.service' }}
      title="Remote Control logs"
      foot={
        <p className={FOOT}>
          The unit's whole journal, which is mostly not events: every remote session writes its full
          stream-json transcript to this same stdout, so a search here is searching transcripts as
          well as the server's own lines. The Connection board above is the filtered view: the
          server's lines are the ones prefixed <span className={MONO}>[HH:MM:SS]</span>, which a
          transcript line cannot be.
        </p>
      }
    />
  )
}
