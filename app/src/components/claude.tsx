import { useEffect, useState } from 'react'

// Types ONLY. The module behind them reads the host snapshot through
// node:fs, and a value import from here would put that in the browser bundle
// — see the warning at the foot of lib/dashboard/claude.ts. The two derived
// helpers this page needs live at the bottom of this file for the same
// reason. claude-rc-request is under the same rule (it imports the bridge,
// which reads node:fs), which is why its idle shape is restated below.
import type { ClaudeRcStatus } from '../lib/claude-rc-request'
import type { ClaudeData, ClaudeFacts, ClaudeSession, RcEvent } from '../lib/dashboard/claude'
import { bytes, DASH, duration, ms, num, since, text, until } from '../lib/format'
import { fetchClaudeRcStatusFn, requestClaudeRestartFn } from '../server/claude'
import { LogBoard } from './logs'
import { Changelog } from './release-notes'
import { ServiceHead } from './service-head'
import { usePolledStatus } from './status'
import { Board, BoardGrid, Chip, Facts, Stat, StatStrip, type Tone } from './viz'

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
  const live = liveSessions(facts)
  const verdict = versionVerdict(data)
  const up = facts.service.activeState === 'active'

  const running = facts.remote.version ?? facts.cli.version
  const envId = facts.remote.environmentId
  const refreshIn =
    facts.credentials.refreshExpiresAt === null
      ? null
      : (facts.credentials.refreshExpiresAt - Date.now()) / 1000

  return (
    <>
      <ServiceHead
        logo="/icon-claude.svg"
        name="Claude Code"
        version={running}
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
            note: 'the weekly flake update is the path; the store binary cannot self-update',
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
            <a
              className="btn"
              href={`https://claude.ai/code?environment=${envId}`}
              target="_blank"
              rel="noreferrer"
            >
              ↗ Open a session
            </a>
          )
        }
      />

      {/* Said once, at the top, and not repeated on every board below: when
          the snapshot has stopped the whole page is a photograph, and a
          reader who has been told that can discount all of it at once. */}
      {!data.available ? (
        <p className="viz-empty">
          The host snapshot has never been written, so nothing below is a reading.{' '}
          <span className="mono">daedalus-claude-snapshot.service</span> is what produces it.
        </p>
      ) : data.stale ? (
        <p className="viz-empty">
          The snapshot is <b>{since((data.ageMs ?? 0) / 1000)}</b> and its timer promises one a
          minute, so the sessions and the unit state below are a photograph rather than a reading.
        </p>
      ) : null}

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
          value={live.length}
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

      <BoardGrid>
        <Board
          title="Remote control"
          icon="panels"
          span={4}
          aside={
            <span className="board-note">
              {facts.remote.spawnMode === null ? 'not announced' : facts.remote.spawnMode}
            </span>
          }
        >
          <Facts
            list
            rows={[
              { k: 'Unit', v: <UnitState data={data} /> },
              {
                k: 'Environment',
                v: <span className="mono">{text(envId)}</span>,
              },
              {
                k: 'Capacity',
                v: `${num(live.length)} / ${facts.remote.maxSessions === null ? DASH : num(facts.remote.maxSessions)}`,
              },
              { k: 'Default model', v: <span className="mono">{text(facts.settings.model)}</span> },
              { k: 'Effort', v: text(facts.settings.effortLevel) },
              { k: 'Plan', v: text(facts.credentials.subscriptionType) },
              {
                k: 'Re-login due',
                v: refreshIn === null ? DASH : until(refreshIn),
              },
              {
                k: 'Memory',
                v: bytes(facts.service.memoryBytes),
              },
              {
                k: 'CPU',
                v: facts.service.cpuNsec === null ? DASH : duration(facts.service.cpuNsec / 1e9),
              },
            ]}
          />
          <p className="board-foot">
            The environment id is what a phone connects to, and it is minted per server start — the
            link in the header carries it, so a restart changes the link and the old one stops
            resolving. Spawn mode <span className="mono">same-dir</span> means a session started
            from claude.ai lands in <span className="mono">/etc/nixos</span>, this repo, with the
            permission matrix and <span className="mono">bash-guard.sh</span> in force exactly as
            they are on the console. Memory and CPU are the whole unit including every session under
            it, which is why they are large.
          </p>
          <RestartServerControl live={live.length} />
        </Board>

        <Board
          title="Sessions"
          icon="panels"
          span={8}
          aside={
            <span className="board-note">
              {live.length === 0 ? 'none connected' : `${num(live.length)} connected`}
            </span>
          }
        >
          {live.length === 0 ? (
            <p className="viz-empty">
              Nothing is connected. The server is still listening, and a session appears here within
              a minute of being started from claude.ai or the app.
            </p>
          ) : (
            <ul className="itemlist">
              {live.map((s) => (
                <SessionRow key={s.pid} session={s} />
              ))}
            </ul>
          )}
          {facts.sessions.some((s) => !s.alive) && (
            <p className="board-foot">
              {num(facts.sessions.filter((s) => !s.alive).length)} session{' '}
              {facts.sessions.filter((s) => !s.alive).length === 1 ? 'file' : 'files'} in{' '}
              <span className="mono">~/.claude/sessions</span> have no process behind them. Not
              shown above, and not an error either: a session that exits uncleanly leaves its file.
              The count is only worth watching if it grows without bound.
            </p>
          )}
          <p className="board-foot">
            <b>Last seen</b> is the mtime of the session's own bridge debug log, which is the only
            clock a session has: the file in <span className="mono">~/.claude/sessions</span> is
            written once, at start, so it says when a session BEGAN and nothing about whether
            anybody is still typing into it. A session idle for hours is normal. What a session
            does not survive is the server: Remote Control is a bridge for STARTING sessions, not
            for re-attaching to ones that lost their process, so once the server dies the web side
            can only mint new sessions — the "restart" button claude.ai offers on a dead one
            starts fresh. The transcript survives on this box, and{' '}
            <span className="mono">claude --resume</span> at the console is the way back into it.
          </p>
        </Board>

        <Board
          title="Connection"
          icon="logs"
          span={6}
          aside={<span className="board-note">last 14 days</span>}
        >
          {data.events.length === 0 ? (
            <p className="viz-empty">
              Nothing in the window. Either the server has been up and connected throughout, or its
              journal has been rotated past. These lines are read back out of Loki.
            </p>
          ) : (
            <ul className="itemlist">
              {data.events.slice(0, 14).map((e) => (
                <EventRow key={`${String(e.at)}-${e.text}`} event={e} />
              ))}
            </ul>
          )}
          <p className="board-foot">
            A <b>drop</b> is the server losing its link to Anthropic and backing off; it retries on
            an escalating ladder and the sessions survive, so a burst of these followed by a
            reconnect is the system working. Bursts landing at <span className="mono">:00</span> are
            worth reading as the box rather than the network: myspeed runs a speedtest on the hour
            and saturates the uplink for a minute or two, which is the same blackout that eats DNS
            house-wide. A <b>token refresh</b> is routine bookkeeping on a long-lived session.
          </p>
        </Board>

        <Board title="Sign-in" icon="▣" span={6}>
          {!facts.credentials.present ? (
            <p className="viz-empty">
              No credentials file. Nobody has run <span className="mono">/login</span> on this box,
              which means Remote Control cannot connect at all.
            </p>
          ) : (
            <>
              <Facts
                list
                rows={[
                  { k: 'Plan', v: text(facts.credentials.subscriptionType) },
                  {
                    k: 'Rate limit tier',
                    v: <span className="mono">{text(facts.credentials.rateLimitTier)}</span>,
                  },
                  {
                    k: 'Access token',
                    v:
                      facts.credentials.expiresAt === null
                        ? DASH
                        : until((facts.credentials.expiresAt - Date.now()) / 1000),
                  },
                  {
                    k: 'Refresh token',
                    v: refreshIn === null ? DASH : until(refreshIn),
                  },
                  {
                    k: 'Scopes',
                    v: (
                      <span className="mono">
                        {facts.credentials.scopes.length === 0
                          ? DASH
                          : facts.credentials.scopes.join(' · ')}
                      </span>
                    ),
                  },
                ]}
              />
              <p className="board-foot">
                Two clocks, and only the second is a date to act on. The access token is refreshed
                automatically about once an hour and its expiry is never the problem. The{' '}
                <b>refresh</b> token running out is: Remote Control stops connecting, with no other
                warning anywhere on this box. The fix is manual and takes a minute: SSH in, run{' '}
                <span className="mono">claude</span> in <span className="mono">/etc/nixos</span>,{' '}
                <span className="mono">/login</span>, then the restart control on this page. Neither
                token is in the snapshot this page reads; only the two dates and the plan are
                copied out.
              </p>
            </>
          )}
        </Board>

        <Changelog
          gap={data.gap}
          span={12}
          aside={<span className="board-note">anthropics/claude-code</span>}
          foot={
            <p className="board-foot">
              The store binary cannot update itself, so being behind here is not a thing that
              resolves on its own. The path is <span className="mono">nix flake update</span>, or
              the weekly <span className="mono">flake-autoupgrade.timer</span> that runs it. A
              rebuild deliberately does NOT restart this unit onto the new build — it once killed
              its own activation doing so — so after the bump the server runs the old binary until
              the next reboot, or the restart control on this page. {verdict.note}
            </p>
          }
        />

        <LogBoard
          source={{ unit: 'claude-remote-control.service' }}
          title="Remote Control logs"
          foot={
            <p className="board-foot">
              The unit's whole journal, which is mostly not events: every remote session writes its
              full stream-json transcript to this same stdout, so a search here is searching
              transcripts as well as the server's own lines. The Connection board above is the
              filtered view: the server's lines are the ones prefixed{' '}
              <span className="mono">[HH:MM:SS]</span>, which a transcript line cannot be.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

const RC_IDLE: ClaudeRcStatus = {
  id: null,
  action: null,
  state: 'idle',
  detail: '',
  error: '',
  startedAt: null,
  finishedAt: null,
}

/** Same arming window as the box restart, for the same reason. */
const RC_ARM_MS = 10_000

/**
 * Restart the Remote Control server.
 *
 * The out-of-band hand for the unit nothing else may touch: rebuilds
 * deliberately never restart it (platform/claude-rc.nix), and a remote
 * session running `systemctl restart` on it kills itself mid-command — so
 * recovering a wedged server, or landing the build a rebuild left pending,
 * is either this button or a reboot of the whole box.
 *
 * Two steps like the box restart, but the cost spelled out at arm time is a
 * different one: sessions, not the house. And unlike its big sibling this
 * flow settles normally — the host agent outlives the restart and writes a
 * real done/failed, so the ordinary status poll covers it.
 */
function RestartServerControl({ live }: { live: number }) {
  const [armed, setArmed] = useState(false)
  const { status, running, start } = usePolledStatus<ClaudeRcStatus>({
    initial: RC_IDLE,
    fetch: () => fetchClaudeRcStatusFn(),
    claimTimeoutMs: 30_000,
  })

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => {
      setArmed(false)
    }, RC_ARM_MS)
    return () => {
      clearTimeout(t)
    }
  }, [armed])

  if (running) {
    return (
      <div className="restart is-running">
        <p className="restart-state">Restarting the server…</p>
      </div>
    )
  }

  if (armed) {
    return (
      <div className="restart is-armed">
        <p className="restart-cost">
          {live === 0
            ? 'Nothing is connected, so this costs nothing right now.'
            : live === 1
              ? 'The one connected session dies with the server.'
              : `All ${num(live)} connected sessions die with the server.`}{' '}
          Dead sessions cannot be picked back up from claude.ai — the server only bridges new
          ones; their transcripts survive on this box and{' '}
          <span className="mono">claude --resume</span> at the console is the way back in. The
          environment id is minted per start, so the session link above becomes a new one. The box
          itself is untouched.
        </p>
        <div className="restart-actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              setArmed(false)
              start(async () => {
                const r = await requestClaudeRestartFn()
                return r.id
              })
            }}
          >
            Confirm restart
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setArmed(false)
            }}
          >
            Cancel
          </button>
          <span className="restart-note">disarms on its own in {RC_ARM_MS / 1000}s</span>
        </div>
      </div>
    )
  }

  return (
    <div className="restart">
      {status.state === 'done' && (
        <p className="restart-state ok-text">
          {status.detail || 'The server restarted.'} The boards above catch up within a minute —
          the snapshot is on a timer.
        </p>
      )}
      {status.state === 'failed' && <p className="restart-state bad-text">{status.error}</p>}
      <button
        type="button"
        className="btn btn-ghost"
        onClick={() => {
          setArmed(true)
        }}
      >
        Restart the server
      </button>
    </div>
  )
}

function UnitState({ data }: { data: ClaudeData }) {
  const { activeState, subState, restarts } = data.facts.service
  const tone: Tone = activeState === 'active' ? 'ok' : activeState === 'unknown' ? 'muted' : 'bad'
  return (
    <>
      <Chip tone={tone}>{subState === '' ? activeState : `${activeState} (${subState})`}</Chip>
      {restarts !== null && restarts > 0 && (
        <span className="item-side">
          {num(restarts)} restart{restarts === 1 ? '' : 's'}
        </span>
      )}
    </>
  )
}

/**
 * One connected session.
 *
 * Named by the CLI's own short label rather than by its id, because that is
 * what claude.ai shows and matching them up is the whole reason to look. The
 * `cse_…` id is beside it for the case where the labels collide, which they
 * do — they are derived from the directory.
 */
function SessionRow({ session }: { session: ClaudeSession }) {
  const idle = session.lastActivityAt === null ? null : (Date.now() - session.lastActivityAt) / 1000

  return (
    <li title={session.transcriptId ?? undefined}>
      {/* Working means "touched in the last minute", which for a session
          being driven from a phone is the honest reading of active. */}
      <Chip tone={idle !== null && idle < 60 ? 'ok' : 'muted'}>
        {idle !== null && idle < 60 ? 'working' : 'idle'}
      </Chip>
      <span className="item-main">{session.name ?? `pid ${String(session.pid)}`}</span>
      {/* `item-min` on the four that a phone drops. What survives is the
          answer to "which session is this and is anything happening in it";
          the id, the directory and the two resource figures are the answer
          to a question you would be at a desk to ask. */}
      <span className="item-side item-min mono">{text(session.remoteId)}</span>
      <span className="item-side item-min mono">{text(session.cwd)}</span>
      <span className="item-side">
        {session.startedAt === null ? DASH : duration((Date.now() - session.startedAt) / 1000)} old
      </span>
      <span className="item-side">last seen {idle === null ? DASH : since(idle)}</span>
      <span className="item-side item-min">{bytes(session.rssBytes)}</span>
      <span className="item-side item-min">{ms(session.cpuMs)} cpu</span>
    </li>
  )
}

const EVENT_TONE: Record<RcEvent['kind'], Tone> = {
  session: 'ok',
  drop: 'warn',
  reconnect: 'ok',
  refresh: 'muted',
  other: 'muted',
}

const EVENT_LABEL: Record<RcEvent['kind'], string> = {
  session: 'session',
  drop: 'drop',
  reconnect: 'reconnect',
  refresh: 'token',
  other: 'note',
}

function EventRow({ event }: { event: RcEvent }) {
  return (
    <li>
      <Chip tone={EVENT_TONE[event.kind]}>{EVENT_LABEL[event.kind]}</Chip>
      <span className="item-main">{event.text}</span>
      <span className="item-side">{since((Date.now() - event.at) / 1000)}</span>
    </li>
  )
}

/* ── derived from the payload ─────────────────────────────────────────────
   Beside the view rather than beside the loader, and not by preference: the
   loader's module reads the host snapshot through node:fs, so importing a
   value from it here is what takes the page down. */

/** Sessions actually connected, newest first. */
function liveSessions(facts: ClaudeFacts): ClaudeSession[] {
  return facts.sessions
    .filter((s) => s.alive)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
}

/**
 * The version verdict, and why it is three-way rather than two.
 *
 * "Behind" here means two different things and they have different remedies.
 * The flake being behind upstream is a `nix flake update` away and is what
 * every other service on this dashboard means by the word. The unit running
 * an OLDER build than the flake already holds is a restart away — and it is
 * the one that hides, because the store path is right, the rebuild succeeded,
 * and nothing anywhere says the process never came back onto it.
 */
function versionVerdict(data: ClaudeData): { label: string; tone: Tone; note: string } {
  const { remote, cli } = data.facts
  if (remote.version !== null && cli.version !== null && remote.version !== cli.version) {
    return {
      label: 'restart pending',
      tone: 'warn',
      note: `The flake holds ${cli.version} and the running server is ${remote.version}, so this unit has not been restarted onto what the last rebuild built.`,
    }
  }
  if (data.gap.installed === null) return { label: 'unknown', tone: 'muted', note: '' }
  if (data.gap.latest === null) {
    return { label: 'unknown', tone: 'muted', note: data.gap.note ?? 'GitHub did not answer.' }
  }
  const behind = data.gap.behind.length
  return behind === 0
    ? { label: 'current', tone: 'ok', note: 'Nothing has been published above this one.' }
    : {
        label: behind === 1 ? '1 release behind' : `${String(behind)} releases behind`,
        tone: 'warn',
        note: '',
      }
}
