import { useEffect, useState } from 'react'

// Types ONLY. The module behind them reads the host snapshot through
// node:fs, and a value import from here would put that in the browser bundle
// — see the warning at the foot of lib/dashboard/claude.ts. The two derived
// helpers this page needs live at the bottom of this file for the same
// reason. claude-rc-request is under the same rule (it imports the bridge,
// which reads node:fs), which is why its idle shape is restated below.
import type { ClaudeRcStatus } from '../host/claude-rc-request'
// Pure and client-safe — the whole reason the roster's types and its join live
// in lib/ rather than beside the loader. See the header of claude-roster.ts.
import {
  countByState,
  type RosterEntry,
  type SessionState,
  sessionRows,
} from '../lib/claude-roster'
import { cn } from '../lib/cn'
import type { ClaudeData, ClaudeFacts, ClaudeSession, RcEvent } from '../lib/dashboard/claude'
import type { VersionGap } from '../lib/dashboard/github'
import type { ShotCounts, ShotRun } from '../lib/dashboard/shotter'
import { bytes, DASH, duration, ms, num, since, text, until } from '../lib/format'
import { fetchClaudeRcStatusFn, requestClaudeRestartFn } from '../server/claude'
import { GHOST_BTN } from './apps/shared'
import {
  BOARD_FOOT,
  BOARD_NOTE,
  LIST,
  MONO,
  MONO_FACE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  VIZ_EMPTY,
} from './category/system/shared'
import { LogBoard } from './logs'
import { Changelog } from './release-notes'
import { ServiceHead } from './service-head'
import { usePolledStatus } from './status'
import { Button } from './ui/button'
import { Board, BoardGrid, Chip, Facts, Stat, StatStrip, type Tone } from './viz'

/* A detail that earns its place on a wide row and not on a narrow one. Every
   side slot truncates, so a row of seven on a phone technically fits — as a
   chip, a clipped name and five ellipses, which is width spent to say nothing.
   Dropping the least important outright gives the rest room to be read. */
const NARROW_HIDE = 'max-[50rem]:hidden'

/* The restart control, the same shape as the box's on the Host tab: quiet at
   rest, and the cost — and the red — appear only once it is armed. */
const RESTART =
  'mt-[0.7rem] flex flex-col items-start gap-[0.55rem] border-(--border-soft) border-t pt-[0.75rem]'
const RESTART_ARMED = 'border-t-[color-mix(in_srgb,var(--danger)_40%,var(--border-soft))]'
const RESTART_COST = 'text-[0.78rem] text-(--text-muted) leading-[1.5]'
const RESTART_STATE = 'text-[0.78rem] leading-[1.5]'
const RESTART_NOTE = 'text-[0.7rem] text-muted-foreground leading-[1.5]'

/* The strip holds one run's viewport slices — consecutive crops of a single
   long page — so they lay out as a film row: fixed height, natural width, side
   scroll. Each image is also the link to its full-size self. */
const SHOT_STRIP = 'mt-[0.6rem] mb-[0.2rem] flex gap-2 overflow-x-auto'
const SHOT_IMG = 'block h-[150px] w-auto rounded-[6px] border border-(--border) bg-(--panel-2)'
/* An excerpt, not the artifact: it scrolls rather than grows, and keeps the
   runner's own line breaks. */
const SHOT_LOG =
  'mt-2 max-h-36 overflow-auto rounded-[6px] border border-(--border-soft) bg-(--panel-2) px-[0.6rem] py-2 text-[0.72rem] leading-[1.5] whitespace-pre-wrap text-(--text-muted)'

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

      {/* Said once, at the top, and not repeated on every board below: when
          the snapshot has stopped the whole page is a photograph, and a
          reader who has been told that can discount all of it at once. */}
      {!data.available ? (
        <p className={VIZ_EMPTY}>
          The host snapshot has never been written, so nothing below is a reading.{' '}
          <span className={MONO}>daedalus-claude-snapshot.service</span> is what produces it.
        </p>
      ) : data.stale ? (
        <p className={VIZ_EMPTY}>
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
            <span className={BOARD_NOTE}>
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
                v: <span className={MONO}>{text(envId)}</span>,
              },
              {
                k: 'Capacity',
                v: `${num(live.length)} / ${facts.remote.maxSessions === null ? DASH : num(facts.remote.maxSessions)}`,
              },
              { k: 'Default model', v: <span className={MONO}>{text(facts.settings.model)}</span> },
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
          <p className={BOARD_FOOT}>
            The environment id is what a phone connects to, and it is minted per server start — the
            link in the header carries it, so a restart changes the link and the old one stops
            resolving. Spawn mode <span className={MONO}>same-dir</span> means a session started
            from claude.ai lands in <span className={MONO}>/etc/nixos</span>, this repo, with the
            permission matrix and <span className={MONO}>bash-guard.sh</span> in force exactly as
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
            <span className={BOARD_NOTE}>
              {live.length === 0 ? 'none connected' : `${num(live.length)} connected`}
            </span>
          }
        >
          {live.length === 0 ? (
            <p className={VIZ_EMPTY}>
              Nothing is connected. The server is still listening, and a session appears here within
              a minute of being started from claude.ai or the app.
            </p>
          ) : (
            <ul className={LIST}>
              {live.map((s) => (
                <SessionRow key={s.pid} session={s} />
              ))}
            </ul>
          )}
          {facts.sessions.some((s) => !s.alive) && (
            <p className={BOARD_FOOT}>
              {num(facts.sessions.filter((s) => !s.alive).length)} session{' '}
              {facts.sessions.filter((s) => !s.alive).length === 1 ? 'file' : 'files'} in{' '}
              <span className={MONO}>~/.claude/sessions</span> have no process behind them. Not
              shown above, and not an error either: a session that exits uncleanly leaves its file.
              The count is only worth watching if it grows without bound.
            </p>
          )}
          <p className={BOARD_FOOT}>
            <b>Last seen</b> is the later of two clocks. The file in{' '}
            <span className={MONO}>~/.claude/sessions</span> used to be written once at start, and
            the only other clock was the bridge's debug log — which exists only for sessions started
            from claude.ai, so anything started at the console or resumed in a tmux reported no
            activity at all. CLI 2.1.260 keeps that file current as the session runs, so both
            populations now have a reading and the later one wins. A session idle for hours is
            normal. What a session does not survive is the server: Remote Control is a bridge for
            STARTING sessions, not for re-attaching to ones that lost their process, so once the
            server dies the web side can only mint new sessions — the "restart" button claude.ai
            offers on a dead one starts fresh. The transcript survives on this box, and the roster
            below is what it looks like afterwards.
          </p>
        </Board>

        <RosterBoard data={data} />

        <Board
          title="Connection"
          icon="logs"
          span={6}
          aside={<span className={BOARD_NOTE}>last 14 days</span>}
        >
          {data.events.length === 0 ? (
            <p className={VIZ_EMPTY}>
              Nothing in the window. Either the server has been up and connected throughout, or its
              journal has been rotated past. These lines are read back out of Loki.
            </p>
          ) : (
            <ul className={LIST}>
              {data.events.slice(0, 14).map((e) => (
                <EventRow key={`${String(e.at)}-${e.text}`} event={e} />
              ))}
            </ul>
          )}
          <p className={BOARD_FOOT}>
            A <b>drop</b> is the server losing its link to Anthropic and backing off; it retries on
            an escalating ladder and the sessions survive, so a burst of these followed by a
            reconnect is the system working. Bursts landing at <span className={MONO}>:00</span> are
            worth reading as the box rather than the network: myspeed runs a speedtest on the hour
            and saturates the uplink for a minute or two, which is the same blackout that eats DNS
            house-wide. A <b>token refresh</b> is routine bookkeeping on a long-lived session.
          </p>
        </Board>

        <Board title="Sign-in" icon="▣" span={6}>
          {!facts.credentials.present ? (
            <p className={VIZ_EMPTY}>
              No credentials file. Nobody has run <span className={MONO}>/login</span> on this box,
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
                    v: <span className={MONO}>{text(facts.credentials.rateLimitTier)}</span>,
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
                      <span className={MONO}>
                        {facts.credentials.scopes.length === 0
                          ? DASH
                          : facts.credentials.scopes.join(' · ')}
                      </span>
                    ),
                  },
                ]}
              />
              <p className={BOARD_FOOT}>
                Two clocks, and only the second is a date to act on. The access token is refreshed
                automatically about once an hour and its expiry is never the problem. The{' '}
                <b>refresh</b> token running out is: Remote Control stops connecting, with no other
                warning anywhere on this box. The fix is manual and takes a minute: SSH in, run{' '}
                <span className={MONO}>claude</span> in <span className={MONO}>/etc/nixos</span>,{' '}
                <span className={MONO}>/login</span>, then the restart control on this page. Neither
                token is in the snapshot this page reads; only the two dates and the plan are copied
                out.
              </p>
            </>
          )}
        </Board>

        <Changelog
          gap={data.gap}
          span={12}
          aside={<span className={BOARD_NOTE}>anthropics/claude-code</span>}
          foot={
            <p className={BOARD_FOOT}>
              The store binary cannot update itself, so being behind here is not a thing that
              resolves on its own. The path is <span className={MONO}>nix flake update</span>, or
              the weekly <span className={MONO}>flake-autoupgrade.timer</span> that runs it. A
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
            <p className={BOARD_FOOT}>
              The unit's whole journal, which is mostly not events: every remote session writes its
              full stream-json transcript to this same stdout, so a search here is searching
              transcripts as well as the server's own lines. The Connection board above is the
              filtered view: the server's lines are the ones prefixed{' '}
              <span className={MONO}>[HH:MM:SS]</span>, which a transcript line cannot be.
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
  const { status, running, refusal, start } = usePolledStatus<ClaudeRcStatus>({
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
      <div className={RESTART}>
        <p className={RESTART_STATE}>Restarting the server…</p>
      </div>
    )
  }

  if (armed) {
    return (
      <div className={cn(RESTART, RESTART_ARMED)}>
        <p className={RESTART_COST}>
          {live === 0
            ? 'Nothing is connected, so this costs nothing right now.'
            : live === 1
              ? 'The one connected session dies with the server.'
              : `All ${num(live)} connected sessions die with the server.`}{' '}
          Dead sessions cannot be picked back up from claude.ai — the server only bridges new ones;
          their transcripts survive on this box and <span className={MONO}>claude --resume</span> at
          the console is the way back in. The environment id is minted per start, so the session
          link above becomes a new one. The box itself is untouched.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => {
              setArmed(false)
              start(async () => ({ ok: true, value: (await requestClaudeRestartFn()).id }))
            }}
          >
            Confirm restart
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={GHOST_BTN}
            onClick={() => {
              setArmed(false)
            }}
          >
            Cancel
          </Button>
          <span className={RESTART_NOTE}>disarms on its own in {RC_ARM_MS / 1000}s</span>
        </div>
      </div>
    )
  }

  return (
    <div className={RESTART}>
      {status.state === 'done' && (
        <p className={cn(RESTART_STATE, 'text-success')}>
          {status.detail || 'The server restarted.'} The boards above catch up within a minute — the
          snapshot is on a timer.
        </p>
      )}
      {refusal !== null && <p className={cn(RESTART_STATE, 'text-danger')}>{refusal}</p>}
      {refusal === null && status.state === 'failed' && (
        <p className={cn(RESTART_STATE, 'text-danger')}>{status.error}</p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        onClick={() => {
          setArmed(true)
        }}
      >
        Restart the server
      </Button>
    </div>
  )
}

const shotUrl = (run: string, file: string) => `/api/shot-run/${run}/${file}`

/**
 * The Shotter tab — the sessions' eyes, one tab over from the sessions.
 *
 * `shot` is how an agent on this GUI-less box looks at a web page
 * (stacks/shotter — no daemon, a cold Chromium per run), and the archive it
 * leaves is everything this tab reads. The thumbnails are the newest run's
 * viewport slices, served through api.shot-run out of the same read-only
 * mount. The version story is Playwright's: the image tag embeds the pin and
 * the npm package inside must match it, so one number IS the running
 * version, with microsoft/playwright's releases behind the changelog.
 */
export function ShotterView({ data }: { data: ClaudeData }) {
  const sh = data.shotter
  const latest = sh.latest
  const verdict = shotterVerdict(data.shotterGap)

  return (
    <>
      <ServiceHead
        logo="/icon-shotter.svg"
        name="Shotter"
        version={data.shotterGap.installed}
        versionNote="Playwright — the pin in stacks/shotter/shotter.nix"
        verdict={{ label: verdict.label, tone: verdict.tone }}
        compare={[
          {
            k: 'Running',
            v: data.shotterGap.installed,
            note: 'the image tag embeds it; the npm package inside must match',
          },
          {
            k: 'Latest release',
            v: data.shotterGap.latest,
            note: 'bump playwrightVersion + playwrightDigest together, then rebuild',
          },
          {
            k: 'Base image',
            v: 'playwright:noble',
            note: 'mcr.microsoft.com — Chromium ships inside, digest-pinned',
          },
        ]}
        lede={
          <>
            The box&rsquo;s standing headless-browser lab, and the standard way any agent session
            verifies a web UI from a machine with no screen. Not a daemon: each{' '}
            <span className={MONO}>shot</span> is a cold, throwaway Chromium, and what persists is
            the image, the CLI and this archive. <span className={MONO}>shot help</span> on the box
            is the manual.
          </>
        }
        actions={<Chip tone="muted">no daemon — runs on demand</Chip>}
      />

      {!sh.available && (
        <p className={VIZ_EMPTY}>
          The <span className={MONO}>/shotter</span> mount is not answering — either the rebuild
          that binds it has not landed, or the stack is gone. Nothing below is a reading.
        </p>
      )}

      <StatStrip>
        <Stat
          label="Runs"
          value={sh.totalRuns}
          sub="all-time, from the ledger"
          title="Every shot invocation ever, counted by stats.json. Prune trims the archive, never this."
        />
        <Stat
          label="Failed"
          value={sh.failedRuns}
          // A failure here is the runner dying, which an agent sees and acts
          // on at the terminal — history, not an alarm.
          tone={
            sh.failedRuns > 0 && sh.totalRuns > 0 && sh.failedRuns * 4 > sh.totalRuns
              ? 'warn'
              : undefined
          }
          sub="runner died mid-run"
        />
        <Stat
          label="Archive"
          value={sh.archived}
          sub={`run dirs · ${bytes(sh.runsBytes)}`}
          title="What prune has kept: 30 days, at most 40 runs. The ledger remembers everything."
        />
        <Stat
          label="Last run"
          value={sh.updatedAt === null ? 'never' : since((Date.now() - sh.updatedAt) / 1000)}
          // Deliberately never a warning tone: runs happen when an agent
          // needs eyes, and a quiet week is a true reading, not staleness.
          sub="quiet is a reading"
        />
      </StatStrip>

      <BoardGrid>
        <Board
          title="Latest run"
          icon="panels"
          span={4}
          aside={
            latest === null ? undefined : (
              <span className={cn(BOARD_NOTE, MONO_FACE)}>{latest.id}</span>
            )
          }
        >
          {latest === null ? (
            <p className={VIZ_EMPTY}>
              No run directories yet. <span className={MONO}>shot quick &lt;url&gt;</span> makes the
              first one.
            </p>
          ) : (
            <>
              {latest.shots.length > 0 && (
                <div className={SHOT_STRIP}>
                  {latest.shots.map((f) => (
                    <a key={f} href={shotUrl(latest.id, f)} target="_blank" rel="noreferrer">
                      <img
                        className={SHOT_IMG}
                        src={shotUrl(latest.id, f)}
                        alt={`${latest.id} — ${f}`}
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              )}
              {latest.log.length > 0 && <pre className={SHOT_LOG}>{latest.log.join('\n')}</pre>}
            </>
          )}
          <p className={BOARD_FOOT}>
            The newest run&rsquo;s viewport slices — consecutive crops of one long page, each
            linking to its full-size self — and the runner&rsquo;s own log under them. The full
            evidence (every slice, <span className={MONO}>events.json</span>,{' '}
            <span className={MONO}>log.txt</span>) is{' '}
            <span className={MONO}>shot show &lt;id&gt;</span> on the box.
          </p>
        </Board>

        <Board
          title="Runs"
          icon="logs"
          span={8}
          aside={
            <span className={BOARD_NOTE}>
              {sh.runs.length === 0 ? 'none yet' : `last ${num(sh.runs.length)}, newest first`}
            </span>
          }
        >
          {sh.runs.length === 0 ? (
            <p className={VIZ_EMPTY}>
              Nothing in the ledger. <span className={MONO}>shot quick &lt;url&gt;</span> writes the
              first line.
            </p>
          ) : (
            <ul className={LIST}>
              {sh.runs.map((r) => (
                <ShotRunRow key={r.id} run={r} />
              ))}
            </ul>
          )}
          <p className={BOARD_FOOT}>
            The append-only ledger, one line per <span className={MONO}>shot</span> invocation. The
            verdict chip reads the run&rsquo;s event counters, not its screenshots — events outrank
            pixels, because a page can render beautifully over a broken deploy. <b>fail</b> is the
            runner itself dying; <b>issues</b> is a page that answered with console errors, failed
            requests or 4xx/5xx underneath.
          </p>
        </Board>

        <Changelog
          gap={data.shotterGap}
          span={12}
          aside={<span className={BOARD_NOTE}>microsoft/playwright</span>}
          foot={
            <p className={BOARD_FOOT}>
              The one dependency under <span className={MONO}>shot</span> — Chromium arrives inside
              Playwright&rsquo;s image, so this is the whole upgrade story. Moving is a paired edit
              in <span className={MONO}>stacks/shotter/shotter.nix</span>:{' '}
              <span className={MONO}>playwrightVersion</span> and{' '}
              <span className={MONO}>playwrightDigest</span> together (Playwright refuses browsers
              from a different revision), then a rebuild rebuilds the image. {verdict.note}
            </p>
          }
        />

        <LogBoard
          source={{ unit: 'shotter-image.service' }}
          title="Image build logs"
          foot={
            <p className={BOARD_FOOT}>
              The rebuild-time image build — layer cache makes the no-change case near-silent, so
              lines here mean the Playwright pin moved or a fresh box paid the base pull. The runs
              themselves do NOT log here: each run&rsquo;s log lives in its own run directory,
              excerpted above.
            </p>
          }
          neighbours={[
            {
              source: { unit: 'shotter-prune.service' },
              label: 'shotter-prune',
              role: 'the weekly archive trim',
              note: 'Sunday 04:20, 30 days back, at most 40 runs kept. Monitored — a failure mails the operator.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}

function ShotRunRow({ run }: { run: ShotRun }) {
  const bad = issueSummary(run.counts)
  return (
    <li className={ROW} title={run.id}>
      <Chip tone={!run.ok ? 'bad' : bad === null ? 'ok' : 'warn'}>
        {!run.ok ? 'fail' : bad === null ? 'clean' : 'issues'}
      </Chip>
      <span className={ROW_MAIN}>{run.label === '' ? run.id : run.label}</span>
      {bad !== null && <span className={ROW_SIDE}>{bad}</span>}
      <span className={ROW_SIDE}>
        {num(run.shots)} shot{run.shots === 1 ? '' : 's'}
      </span>
      <span className={cn(ROW_SIDE, NARROW_HIDE)}>
        {run.durationMs === null ? DASH : ms(run.durationMs)}
      </span>
      <span className={ROW_SIDE}>
        {run.at === null ? DASH : since((Date.now() - run.at) / 1000)}
      </span>
    </li>
  )
}

/**
 * Simpler than the Claude verdict on purpose: shotter has no restart-pending
 * state to detect — the image tag embeds the pin, so a rebuild that moves it
 * rebuilds the image, and every run after that is on the new one.
 */
function shotterVerdict(gap: VersionGap): { label: string; tone: Tone; note: string } {
  if (gap.installed === null) {
    return {
      label: 'unknown',
      tone: 'muted',
      note: 'The pin has not reached this container — a rebuild older than the env var.',
    }
  }
  if (gap.latest === null) {
    return { label: 'unknown', tone: 'muted', note: gap.note ?? 'GitHub did not answer.' }
  }
  const behind = gap.behind.length
  return behind === 0
    ? { label: 'current', tone: 'ok', note: 'Nothing has been published above this one.' }
    : {
        label: behind === 1 ? '1 release behind' : `${String(behind)} releases behind`,
        tone: 'warn',
        note: '',
      }
}

/** The counters that matter, compressed to one phrase; null = a clean page. */
function issueSummary(c: ShotCounts): string | null {
  const parts = [
    c.consoleError > 0 ? `${num(c.consoleError)} console` : null,
    c.pageError > 0 ? `${num(c.pageError)} page-err` : null,
    c.requestFailed > 0 ? `${num(c.requestFailed)} req-failed` : null,
    c.http4xx > 0 ? `${num(c.http4xx)}× 4xx` : null,
    c.http5xx > 0 ? `${num(c.http5xx)}× 5xx` : null,
  ].filter((p) => p !== null)
  return parts.length === 0 ? null : parts.join(' · ')
}

function UnitState({ data }: { data: ClaudeData }) {
  const { activeState, subState, restarts } = data.facts.service
  const tone: Tone = activeState === 'active' ? 'ok' : activeState === 'unknown' ? 'muted' : 'bad'
  return (
    <>
      <Chip tone={tone}>{subState === '' ? activeState : `${activeState} (${subState})`}</Chip>
      {restarts !== null && restarts > 0 && (
        <span className={ROW_SIDE}>
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
    <li className={ROW} title={session.transcriptId ?? undefined}>
      {/* The session's own word first, when it has one: `busy` is the CLI
          saying it is mid-turn, which no clock can infer. Falling back to
          "touched in the last minute", the honest reading of active for a
          session being driven from a phone. */}
      <Chip tone={working(session) ? 'ok' : 'muted'}>{working(session) ? 'working' : 'idle'}</Chip>
      <span className={ROW_MAIN}>{session.name ?? `pid ${String(session.pid)}`}</span>
      {/* `item-min` on the four that a phone drops. What survives is the
          answer to "which session is this and is anything happening in it";
          the id, the directory and the two resource figures are the answer
          to a question you would be at a desk to ask. */}
      <span className={cn(ROW_SIDE, NARROW_HIDE, MONO_FACE)}>{text(session.remoteId)}</span>
      <span className={cn(ROW_SIDE, NARROW_HIDE, MONO_FACE)}>{text(session.cwd)}</span>
      <span className={ROW_SIDE}>
        {session.startedAt === null ? DASH : duration((Date.now() - session.startedAt) / 1000)} old
      </span>
      <span className={ROW_SIDE}>last seen {idle === null ? DASH : since(idle)}</span>
      <span className={cn(ROW_SIDE, NARROW_HIDE)}>{bytes(session.rssBytes)}</span>
      <span className={cn(ROW_SIDE, NARROW_HIDE)}>{ms(session.cpuMs)} cpu</span>
    </li>
  )
}

/* ── the roster ───────────────────────────────────────────────────────────
   The board above is what is CONNECTED. This one is everything this box could
   still be asked about, joined from two sources that disagree on purpose. */

const STATE_TONE: Record<SessionState, Tone> = {
  alive: 'ok',
  background: 'info',
  orphan: 'warn',
  resumable: 'muted',
}

const STATE_LABEL: Record<SessionState, string> = {
  alive: 'alive',
  background: 'background',
  orphan: 'no transcript',
  resumable: 'resumable',
}

/** As many rows as read as a list rather than as a log. The rest are counted. */
const ROSTER_ROWS = 24

function RosterBoard({ data }: { data: ClaudeData }) {
  const { roster } = data.facts
  const rows = sessionRows(roster, data.facts.sessions)
  const counts = countByState(rows)
  const shown = rows.slice(0, ROSTER_ROWS)

  return (
    <Board
      title="Session roster"
      icon="panels"
      span={12}
      aside={
        <span className={BOARD_NOTE}>
          {rows.length === 0
            ? 'nothing on disk'
            : `${num(counts.alive + counts.background)} running · ${num(counts.resumable)} resumable`}
        </span>
      }
    >
      {rows.length === 0 ? (
        <p className={VIZ_EMPTY}>
          No transcripts and no agents. Either this snapshot predates the roster — the boards above
          still read correctly without it — or nobody has ever run{' '}
          <span className={MONO}>claude</span> as this user.
        </p>
      ) : (
        <ul className={LIST}>
          {shown.map((r) => (
            <RosterRow key={r.key} row={r} />
          ))}
        </ul>
      )}

      {rows.length > shown.length && (
        <p className={BOARD_FOOT}>
          {num(rows.length - shown.length)} older transcript
          {rows.length - shown.length === 1 ? '' : 's'} not listed, of {num(roster.transcriptTotal)}{' '}
          on disk.
          {roster.emptyCount > 0 && (
            <>
              {' '}
              {num(roster.emptyCount)} more {roster.emptyCount === 1 ? 'is' : 'are'} empty — opened
              and never spoken to, so there is nothing in them to resume.
            </>
          )}
        </p>
      )}

      <p className={BOARD_FOOT}>
        Two sources, and which one said a thing is part of the answer.{' '}
        <span className={MONO}>claude agents</span> is authoritative for what is <b>running</b> — it
        is the only thing that knows about background agents, including ones whose project directory
        is gone (drawn <b>no transcript</b>). The <span className={MONO}>.jsonl</span> files under{' '}
        <span className={MONO}>~/.claude/projects</span> are authoritative for what is{' '}
        <b>resumable</b> and for nothing else: a transcript records that a conversation happened,
        never that anything is still behind it.
      </p>

      <p className={BOARD_FOOT}>
        <b>Resume continues the session it names.</b>{' '}
        <span className={MONO}>claude --resume &lt;id&gt;</span> keeps that session id and appends
        to that same transcript — measured here on CLI 2.1.260, both at the console and with{' '}
        <span className={MONO}>--remote-control</span>: the file grew in place, the id came back
        unchanged, and the conversation picked up where it had stopped. Starting a branch instead is
        the opt-in, <span className={MONO}>--fork-session</span>, and nothing on this page passes
        it. A <b>background</b> row has its own two verbs, which take the short id rather than the
        uuid: <span className={MONO}>claude attach &lt;short id&gt;</span> returns to a process that
        never stopped, <span className={MONO}>claude stop &lt;short id&gt;</span> ends it. There is
        no end-of-session marker anywhere, so "finished cleanly" is not a thing this board can know
        — a transcript with nothing running behind it is all it can honestly say.
      </p>

      <p className={BOARD_FOOT}>
        Titles are labels, never content. What is copied out of the transcript tree is an{' '}
        <span className={MONO}>ai-title</span>, a title the operator typed, or the short name the
        CLI derives — and nothing else. Those files hold pasted keys, tokens and the output of{' '}
        <span className={MONO}>sops -d</span>; this page is served out of a world-readable snapshot,
        so a row falls back to its id rather than borrowing a line of the conversation.
      </p>
    </Board>
  )
}

function RosterRow({ row }: { row: RosterEntry }) {
  return (
    <li className={ROW} title={row.id ?? undefined}>
      <Chip tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Chip>
      <span className={ROW_MAIN}>{row.label}</span>
      {/* An INTERACTIVE session's name is derived by the CLI (`nixos-ac`) and
          names the session rather than the work, so it is marked as the weak
          label it is. A background agent's name is the one it was launched
          with — a real title — and marking that would be a lie. */}
      {row.labelSource === 'agent' && row.state !== 'background' && (
        <span className={cn(ROW_SIDE, NARROW_HIDE)}>cli name</span>
      )}
      {row.lifecycle !== null && <span className={ROW_SIDE}>{row.lifecycle}</span>}
      <span className={cn(ROW_SIDE, NARROW_HIDE, MONO_FACE)}>
        {row.shortId ?? (row.id === null ? DASH : row.id.slice(0, 8))}
      </span>
      <span className={cn(ROW_SIDE, NARROW_HIDE, MONO_FACE)}>
        {text(row.cwd)}
        {!row.cwdExact && '?'}
      </span>
      <span className={ROW_SIDE}>
        {row.modifiedAt === null ? DASH : since((Date.now() - row.modifiedAt) / 1000)}
      </span>
      <span className={cn(ROW_SIDE, NARROW_HIDE)}>{bytes(row.sizeBytes)}</span>
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
    <li className={ROW}>
      <Chip tone={EVENT_TONE[event.kind]}>{EVENT_LABEL[event.kind]}</Chip>
      <span className={ROW_MAIN}>{event.text}</span>
      <span className={ROW_SIDE}>{since((Date.now() - event.at) / 1000)}</span>
    </li>
  )
}

/* ── derived from the payload ─────────────────────────────────────────────
   Beside the view rather than beside the loader, and not by preference: the
   loader's module reads the host snapshot through node:fs, so importing a
   value from it here is what takes the page down. */

/** Mid-turn now, by the session's own word or by its clock. */
function working(session: ClaudeSession): boolean {
  if (session.status === 'busy') return true
  return session.lastActivityAt !== null && Date.now() - session.lastActivityAt < 60_000
}

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
