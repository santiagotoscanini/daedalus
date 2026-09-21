import { ClockIcon, FolderGit2Icon, MessagesSquareIcon } from 'lucide-react'
import { useEffect, useState } from 'react'

// Types ONLY. The module behind them reads the host snapshot through
// node:fs, and a value import from here would put that in the browser bundle
// — see the warning at the foot of lib/dashboard/claude.ts. The two derived
// helpers this page needs live at the bottom of this file for the same
// reason. claude-rc-request is under the same rule (it imports the bridge,
// which reads node:fs), which is why its idle shape is restated below.
import type { ClaudeRcStatus } from '../host/claude-rc-request'
import type { ClaudeSessionStatus } from '../host/claude-session-request'
// Pure and client-safe — the whole reason the roster's types, its join and
// the row's derived facts live in lib/ rather than beside the loader. See the
// header of claude-roster.ts.
import { type FactIcon, factGroups, promptLine } from '../lib/claude-meta'
import {
  countByState,
  type RosterEntry,
  type RowControl,
  rowControl,
  type SessionState,
  sessionRows,
} from '../lib/claude-roster'
import { cn } from '../lib/cn'
import type { ClaudeData, ClaudeFacts, ClaudeSession, RcEvent } from '../lib/dashboard/claude'
import type { VersionGap } from '../lib/dashboard/github'
import type { ShotCounts, ShotRun } from '../lib/dashboard/shotter'
import { bytes, DASH, duration, ms, num, since, text, until } from '../lib/format'
import { toneStyle } from '../lib/tone'
import {
  fetchClaudeRcStatusFn,
  fetchClaudeSessionStatusFn,
  removeSessionFn,
  requestClaudeRestartFn,
  resumeSessionFn,
  stopSessionFn,
} from '../server/claude'
import { GHOST_BTN } from './apps/shared'
import { LogBoard } from './logs'
import { Changelog } from './release-notes'
import { ServiceHead } from './service-head'
import { usePolledStatus } from './status'
import { EMPTY, FOOT, LIST, MONO, MONO_FACE, NOTE, ROW, ROW_MAIN, ROW_SIDE } from './tokens'
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
        <p className={EMPTY}>
          The host snapshot has never been written, so nothing below is a reading.{' '}
          <span className={MONO}>daedalus-claude-snapshot.service</span> is what produces it.
        </p>
      ) : data.stale ? (
        <p className={EMPTY}>
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
          span={6}
          aside={
            <span className={NOTE}>
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
          <p className={FOOT}>
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

        {/* Sign-in comes up beside Remote control. The two are one subject —
            what this server is, and whether it can still reach Anthropic —
            and row 1 is where the page's standing facts belong. It takes the
            8 the Sessions board vacated. */}
        <Board title="Sign-in" icon="▣" span={6}>
          {!facts.credentials.present ? (
            <p className={EMPTY}>
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
                  { k: 'Refresh token', v: refreshIn === null ? DASH : until(refreshIn) },
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
              <p className={FOOT}>
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

        <Board
          title="Connection"
          icon="logs"
          span={6}
          aside={<span className={NOTE}>last 14 days</span>}
        >
          {data.events.length === 0 ? (
            <p className={EMPTY}>
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
          <p className={FOOT}>
            A <b>drop</b> is the server losing its link to Anthropic and backing off; it retries and
            the sessions survive, so a burst followed by a reconnect is the system working. Bursts
            landing at <span className={MONO}>:00</span> are the box rather than the network —
            myspeed's hourly speedtest saturates the uplink for a minute or two.
          </p>
        </Board>

        {/* Beside Connection rather than across the page. The two answer the
            same question from opposite ends — is this server talking to
            Anthropic right now, and is it the build that should be — and a
            version list is a column of short rows that never needed 12. */}
        <Changelog
          gap={data.gap}
          span={6}
          aside={<span className={NOTE}>anthropics/claude-code</span>}
          foot={
            <p className={FOOT}>
              The store binary cannot update itself: the path is{' '}
              <span className={MONO}>nix flake update</span>, or the weekly{' '}
              <span className={MONO}>flake-autoupgrade.timer</span>. A rebuild deliberately does NOT
              restart this unit onto the new build — it once killed its own activation doing so — so
              the server keeps running the old binary until a reboot or the restart control above.{' '}
              {verdict.note}
            </p>
          }
        />

        {/* The reason to open this page, so it sits where the attention goes
            rather than at the foot, where it landed only because it was added
            last. It is also now the ONLY list of sessions here: the Sessions
            board above it drew the live ones a second time, and those are its
            `alive` rows. */}
        <RosterBoard data={data} />

        <LogBoard
          source={{ unit: 'claude-remote-control.service' }}
          title="Remote Control logs"
          foot={
            <p className={FOOT}>
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
        <p className={EMPTY}>
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
            latest === null ? undefined : <span className={cn(NOTE, MONO_FACE)}>{latest.id}</span>
          }
        >
          {latest === null ? (
            <p className={EMPTY}>
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
          <p className={FOOT}>
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
            <span className={NOTE}>
              {sh.runs.length === 0 ? 'none yet' : `last ${num(sh.runs.length)}, newest first`}
            </span>
          }
        >
          {sh.runs.length === 0 ? (
            <p className={EMPTY}>
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
          <p className={FOOT}>
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
          aside={<span className={NOTE}>microsoft/playwright</span>}
          foot={
            <p className={FOOT}>
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
            <p className={FOOT}>
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

/* ── the roster ───────────────────────────────────────────────────────────

   Everything this box could still be asked about, joined from two sources
   that disagree on purpose — and, since the Sessions board was folded into
   it, the only list of connected sessions on the page as well. That board
   drew the live sessions and this one drew the same sessions again as its
   `alive` rows; one population in two lists meant holding both to answer
   "what is running". What was only on that board — the `cse_…` id, the CLI's
   own name, RSS, CPU, and the session's own activity clock — is on the row it
   describes now. The `StatStrip` above is not a duplicate of either and
   stays: `N of 32` is a fact about the server, not about a session. */

const STATE_TONE: Record<SessionState, Tone> = {
  alive: 'ok',
  background: 'info',
  // Not `info`, and not `warn` either: a dormant record is neither running nor
  // broken. It is a leftover, and it should read as quietly as the resumable
  // tail rather than borrowing the colour of the two live populations — which
  // is exactly what it was doing while it shared `background`'s chip.
  dormant: 'muted',
  orphan: 'warn',
  resumable: 'muted',
}

const STATE_LABEL: Record<SessionState, string> = {
  alive: 'alive',
  background: 'background',
  dormant: 'dormant',
  orphan: 'no transcript',
  resumable: 'resumable',
}

/** As many rows as read as a list rather than as a log. The rest are counted. */
const ROSTER_ROWS = 24

const SESSION_IDLE: ClaudeSessionStatus = {
  id: null,
  action: null,
  session: null,
  state: 'idle',
  detail: '',
  error: '',
  startedAt: null,
  finishedAt: null,
}

/* The verb at the right edge OF the row, not under it.

   It used to be a second line of its own, which made every row two lines tall
   and turned fifty of them into a ragged column with a button floating under
   each one. The rest of this page lays a row out as chip · name · facts, with
   anything actionable at the right edge (the queue on System › Updates is the
   same shape), and this board reads as part of that page only if it does the
   same. `shrink-0` because the two truncating side slots to its left will
   otherwise give away the button's width before their own. */
const ROW_BTN = 'ml-auto h-auto shrink-0 px-[0.55rem] py-[0.2rem] text-[0.7rem]'

/* ── the enriched row ─────────────────────────────────────────────────────

   Three lines: what it is, what was last said to it, and what is in it. The
   grouping is the design — a directory and a branch are one fact, a turn
   count and a file size are one fact, a span and an idle time are one story —
   and it lives in lib/claude-meta.ts so it can be tested without a DOM. */

/* The last prompt. One line, clipped, and in the muted ink the board uses for
   anything that is not a measurement, so it reads as context under the title
   rather than as a second title. */
const PROMPT = 'mt-[0.22rem] truncate text-[0.72rem] leading-[1.45] text-(--text-muted)'

/* The metadata line. Wraps rather than scrolls — a row here is already a
   block, and a horizontal scrollbar inside one would be the third scroll axis
   on the page. The gap is wide enough that the groups read as groups without
   a separator glyph between them. */
const META =
  'mt-[0.2rem] flex min-w-0 flex-wrap items-center gap-x-[0.7rem] gap-y-[0.1rem] text-[0.68rem] text-muted-foreground tabular-nums'
const META_ITEM = 'inline-flex min-w-0 max-w-full items-center gap-[0.28rem]'
const META_ICON = 'shrink-0 opacity-65'

/* The four states have to stay apart, and three lines per row is exactly the
   pressure that would blur them — a page of equally tall blocks reads as one
   population. The chip still carries the verdict; this is a second, quieter
   index down the left edge, so a running session can be found by colour from
   the top of a list of twenty-four.

   Every row carries the border and the padding, so the text edge never moves;
   the two quiet populations simply make theirs transparent. That is the whole
   reason this is not a conditional wrapper. */
const ROW_ACCENT = 'border-l-2 pl-[0.5rem]'
const STATE_ACCENT: Record<SessionState, string> = {
  alive: 'border-l-(--tone)',
  background: 'border-l-(--tone)',
  orphan: 'border-l-(--tone)',
  // A leftover and a dead conversation on disk are not states worth a stripe.
  // They are the resting mass of this board, and the two above have to be
  // findable against them.
  dormant: 'border-l-transparent',
  resumable: 'border-l-transparent',
}

/** The three groups that get a picture instead of a word. */
const FACT_ICONS: Record<FactIcon, typeof ClockIcon> = {
  where: FolderGit2Icon,
  size: MessagesSquareIcon,
  time: ClockIcon,
}

function FactIconFor({ name }: { name: FactIcon }) {
  const Icon = FACT_ICONS[name]
  return <Icon className={META_ICON} size={12} aria-hidden="true" />
}

/* What DOES belong under the row: the armed state. It carries a sentence
   about what the click costs, which is the one thing worth a second line. */
const CTRL = 'mt-[0.3rem] flex flex-wrap items-center gap-2'
const CTRL_COST = 'mt-[0.3rem] text-[0.72rem] text-(--text-muted) leading-[1.5]'
const CTRL_NOTE = 'text-[0.68rem] text-muted-foreground leading-[1.5]'
const CTRL_STATE = 'mt-[0.3rem] text-[0.72rem] leading-[1.5]'

function RosterBoard({ data }: { data: ClaudeData }) {
  const { roster } = data.facts
  const rows = sessionRows(roster, data.facts.sessions)
  // Session files with no process behind them. Carried over from the Sessions
  // board's foot: they are not rows — there is nothing running to draw — and
  // they are not an error either, so a count is the whole of what to say.
  const stale = data.facts.sessions.filter((s) => !s.alive).length
  const counts = countByState(rows)
  const shown = rows.slice(0, ROSTER_ROWS)

  // ONE poller and ONE armed row for the whole board: there is one bridge
  // file behind every button here, so two rows acting at once is not a state
  // the host can be in, and arming a second row must disarm the first.
  const [armed, setArmed] = useState<string | null>(null)
  const { status, running, refusal, start } = usePolledStatus<ClaudeSessionStatus>({
    initial: SESSION_IDLE,
    fetch: () => fetchClaudeSessionStatusFn(),
    claimTimeoutMs: 30_000,
  })

  useEffect(() => {
    if (armed === null) return
    const t = setTimeout(() => {
      setArmed(null)
    }, RC_ARM_MS)
    return () => {
      clearTimeout(t)
    }
  }, [armed])

  return (
    <Board
      title="Session roster"
      icon="panels"
      span={12}
      aside={
        <span className={NOTE}>
          {/* `dormant` counted apart from both, because it is the population
              that was being read as the wrong one: a background RECORD with no
              process behind it is not running, and it is not resumable either
              — the CLI still owns that conversation. */}
          {/* Only the populations that exist. Four counts with zeroes in
              two of them is a legend, not a reading — and the board's whole
              argument is that these four are different things, which is
              easiest to see when only the present ones are named. */}
          {rows.length === 0
            ? 'nothing connected, nothing on disk'
            : (
                [
                  [counts.alive, 'connected'],
                  [counts.background, 'background'],
                  [counts.dormant, 'dormant'],
                  [counts.orphan, 'no transcript'],
                  [counts.resumable, 'resumable'],
                ] as const
              )
                .filter(([k]) => k > 0)
                .map(([k, word]) => `${num(k)} ${word}`)
                .join(' · ')}
        </span>
      }
    >
      {rows.length === 0 ? (
        <p className={EMPTY}>
          No sessions, no transcripts and no agents. Nothing is connected — the server is still
          listening, and a session appears here within a minute of being started from claude.ai or
          the app — and there is nothing on disk to resume either. Failing that, this snapshot
          predates the roster (the boards above still read correctly without it), or nobody has ever
          run <span className={MONO}>claude</span> as this user.
        </p>
      ) : (
        <ul className={LIST}>
          {shown.map((r) => (
            <RosterRow
              key={r.key}
              row={r}
              armed={armed === r.key}
              busy={running}
              status={status}
              refusal={refusal}
              onArm={() => {
                setArmed(r.key)
              }}
              onCancel={() => {
                setArmed(null)
              }}
              onConfirm={(control) => {
                setArmed(null)
                start(async () => {
                  const fn =
                    control.kind === 'resume'
                      ? resumeSessionFn
                      : control.kind === 'remove-agent'
                        ? removeSessionFn
                        : stopSessionFn
                  return { ok: true, value: (await fn({ data: { session: control.session } })).id }
                })
              }}
            />
          ))}
        </ul>
      )}

      {rows.length > shown.length && (
        <p className={FOOT}>
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

      {stale > 0 && (
        <p className={FOOT}>
          {num(stale)} session {stale === 1 ? 'file' : 'files'} in{' '}
          <span className={MONO}>~/.claude/sessions</span> with no process behind{' '}
          {stale === 1 ? 'it' : 'them'} — left by a session that exited uncleanly. Not an error;
          worth watching only if it grows.
        </p>
      )}

      {/* ONE paragraph, deliberately. This foot carried ten, and nine of them
          explained things the board now says by itself: the populations and
          their verbs are the chips and the buttons, a dormant row prints `no
          process`, an armed row states what the press costs, and a fact the
          CLI never recorded is simply absent from the metadata line. That
          reasoning was not deleted, only moved to where the behaviour is —
          lib/claude-roster.ts (two sources, the pid rule, the four verbs, the
          trust guard), lib/claude-meta.ts (how the counts and the prompt are
          derived, why a zero never prints, what the file mode pays for),
          lib/dashboard/claude.ts (the two clocks behind "last seen"),
          host/claude-session-request.ts (the selector and its guards),
          host/claude-rc-request.ts (what a restart does to a session).
          What stays here is the one thing a reader would otherwise get
          WRONG, and the one limit on what the board is able to claim. */}
      <p className={FOOT}>
        <b>Resume continues the session it names.</b>{' '}
        <span className={MONO}>claude --resume &lt;id&gt;</span> keeps that id and appends to that
        same transcript — measured here on CLI 2.1.260, at the console and under{' '}
        <span className={MONO}>--remote-control</span>. Branching is the opt-in,{' '}
        <span className={MONO}>--fork-session</span>, and nothing on this page passes it. Nothing
        writes an end-of-session marker either, so a transcript with no process behind it is all
        this board can honestly say: <b>resumable</b> means there is something to pick up, not that
        it finished.
      </p>
    </Board>
  )
}

/**
 * One row, and — where there is an honest one — its verb.
 *
 * Four populations end four different ways and a fifth does not end at all, so
 * this deliberately does not render one button five times. `rowControl` makes
 * that decision (it is pure, and tested); this only draws it.
 */
function RosterRow({
  row,
  armed,
  busy,
  status,
  refusal,
  onArm,
  onCancel,
  onConfirm,
}: {
  row: RosterEntry
  armed: boolean
  busy: boolean
  status: ClaudeSessionStatus
  refusal: string | null
  onArm: () => void
  onCancel: () => void
  onConfirm: (control: Extract<RowControl, { session: string }>) => void
}) {
  const control = rowControl(row)
  // The board has one status file, so a row only speaks when the host is
  // speaking about IT — otherwise every row would echo the same outcome.
  const mine = control.kind !== 'none' && status.session === control.session
  const prompt = promptLine(row.meta)
  // A row with no title falls back to its own short id for a label, and the
  // id slot then printed the same eight characters a second time, on the same
  // line. One of them is enough: the slot is for the case where the NAME does
  // not identify the row, which is exactly the case where they differ.
  const idCandidate = row.shortId ?? (row.id === null ? null : row.id.slice(0, 8))
  const shownId = idCandidate === row.label ? null : (idCandidate ?? DASH)
  const groups = factGroups(
    {
      cwd: row.cwd,
      cwdExact: row.cwdExact,
      sizeBytes: row.sizeBytes,
      modifiedAt: row.modifiedAt,
      meta: row.meta,
      live: row.live,
    },
    Date.now(),
  )
  // `busy` is the CLI saying it is mid-turn, which no clock can infer. The
  // fallback is "touched within the last minute", which is what the Sessions
  // board called `working` and the honest reading of active for a session
  // being driven from a phone. Only ever shown for a row with a process.
  const lifecycle = row.lifecycle ?? (row.live !== null && working(row.live) ? 'working' : null)
  // The name claude.ai shows. When it IS the label there is nothing to add;
  // when a title outranks it, this is the only place it survives, and the
  // board's whole job is matching a row here to a session over there.
  const cliName = row.live?.name != null && row.live.name !== row.label ? row.live.name : null

  return (
    <li
      className={cn(ROW, 'flex-col items-stretch', ROW_ACCENT, STATE_ACCENT[row.state])}
      title={row.id ?? undefined}
      style={toneStyle(STATE_TONE[row.state])}
    >
      <div className="flex min-w-0 items-center gap-[0.45rem]">
        <Chip tone={STATE_TONE[row.state]}>{STATE_LABEL[row.state]}</Chip>
        <span className={ROW_MAIN}>{row.label}</span>
        {/* An INTERACTIVE session's name is derived by the CLI (`nixos-ac`) and
            names the session rather than the work, so it is marked as the weak
            label it is. A background agent's name is the one it was launched
            with — a real title — and marking that would be a lie. That holds
            whether or not its process is still there, so `dormant` is exempt
            for exactly the reason `background` is. */}
        {row.labelSource === 'agent' && row.state !== 'background' && row.state !== 'dormant' && (
          <span className={cn(ROW_SIDE, NARROW_HIDE)}>cli name</span>
        )}
        {/* A session this box started says so: it is the only live population
            with a kill, and the row is where that difference is decided. */}
        {row.managed && <span className={cn(ROW_SIDE, NARROW_HIDE)}>ours</span>}
        {lifecycle !== null && <span className={ROW_SIDE}>{lifecycle}</span>}
        {/* Spelled out beside the lifecycle word, because that word is what
            misleads: `blocked` is an agent waiting on a human, and reads as a
            live thing pausing. The missing pid is the fact underneath it. */}
        {row.state === 'dormant' && <span className={ROW_SIDE}>no process</span>}
        {/* The id stays on the top line and only there: it is what the CLI
            verbs take, so it belongs beside the name it labels rather than
            down among the measurements. The directory, the size and the last
            write all moved to the metadata line below, each into the group it
            actually belongs to — they were four separate readings of three
            questions. */}
        {cliName !== null && (
          <span className={cn(ROW_SIDE, NARROW_HIDE, MONO_FACE)}>{cliName}</span>
        )}
        {/* The id claude.ai shows, which is NOT the transcript uuid beside
            it. It came off the Sessions board, and it is the thing you match
            a row here against a session over there by. */}
        {row.live?.remoteId != null && (
          <span className={cn(ROW_SIDE, NARROW_HIDE, MONO_FACE)}>{row.live.remoteId}</span>
        )}
        {shownId !== null && (
          <span className={cn(ROW_SIDE, NARROW_HIDE, MONO_FACE)}>{shownId}</span>
        )}
        {/* No button, and the reason in its place. A session the Remote
            Control server spawned has no per-session kill anywhere — not in
            the CLI, not in systemd — so the only honest thing here is a
            sentence. The board foot points at the one lever that does end it. */}
        {control.kind === 'none' && control.why === 'server' && (
          <span className={cn(ROW_SIDE, NARROW_HIDE)}>ends with the server</span>
        )}

        {/* The verb, on the row. It is hidden while armed because Confirm and
            Cancel take its place below — two buttons for one row at once is
            the ambiguity the two-step exists to avoid. */}
        {control.kind !== 'none' && !busy && !armed && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(GHOST_BTN, ROW_BTN)}
            onClick={onArm}
          >
            {control.kind === 'resume'
              ? 'Resume'
              : control.kind === 'remove-agent'
                ? 'Remove'
                : 'Stop'}
          </Button>
        )}
      </div>

      {/* The one line of conversation on this page, and it gets a line of its
          own because it is the only thing here that is not a measurement.
          Quiet ink and a smaller size: it is context for the title above it,
          not a heading of its own. Redacted twice — host-side before it was
          written to a 0600 file, and again by `promptLine` on the way here. */}
      {prompt !== null && (
        <p className={PROMPT} title={prompt}>
          {prompt}
        </p>
      )}

      {/* One line, grouped. Each span answers one question; the three that
          always have an answer carry an icon in place of the word they would
          otherwise need, and the rest keep their words. See
          lib/claude-meta.ts for why a zero never reaches this line. */}
      {groups.length > 0 && (
        <div className={META}>
          {groups.map((g) => (
            <span
              key={g.key}
              className={cn(META_ITEM, g.secondary && NARROW_HIDE)}
              title={g.detail ?? undefined}
            >
              {g.icon !== null && <FactIconFor name={g.icon} />}
              <span className="truncate">{g.text}</span>
            </span>
          ))}
        </div>
      )}

      {mine && status.state === 'running' && (
        <p className={CTRL_STATE}>{status.detail || 'Working…'}</p>
      )}
      {mine && status.state === 'done' && (
        <p className={cn(CTRL_STATE, 'text-success')}>{status.detail || 'Done.'}</p>
      )}
      {mine && status.state === 'failed' && refusal === null && (
        <p className={cn(CTRL_STATE, 'text-danger')}>{status.error}</p>
      )}
      {mine && refusal !== null && <p className={cn(CTRL_STATE, 'text-danger')}>{refusal}</p>}

      {control.kind !== 'none' && !busy && armed && (
        <>
          <p className={CTRL_COST}>
            {control.kind === 'resume' ? (
              <>
                This CONTINUES the session — same id, same transcript, appended to. It comes back as
                a live session on claude.ai, running in <span className={MONO}>/etc/nixos</span> as{' '}
                <span className={MONO}>santiago</span>, with sudo available to it. Nothing is
                branched and nothing is overwritten.
              </>
            ) : control.kind === 'stop-unit' ? (
              <>
                <span className={MONO}>systemctl stop</span> on this session's unit: systemd
                SIGTERMs its whole process group, including anything it is running right now. The
                transcript survives and it can be resumed again from this board.
              </>
            ) : control.kind === 'remove-agent' ? (
              <>
                <span className={MONO}>claude rm {control.session}</span> — the verb for a record,
                which is all this row is. Nothing is being stopped: there is no process behind it,
                and <span className={MONO}>claude stop</span> would have nothing to act on. This
                DELETES the background session and its worktree, so{' '}
                <span className={MONO}>claude attach {control.session}</span> has nothing to reopen
                afterwards — leave it alone if the conversation is still wanted.
              </>
            ) : (
              <>
                <span className={MONO}>claude stop {control.session}</span> — upstream's own verb.
                The agent stops where it is; its conversation is kept, and{' '}
                <span className={MONO}>claude attach {control.session}</span> reopens it.
              </>
            )}
          </p>
          <div className={CTRL}>
            <Button
              type="button"
              variant={control.kind === 'resume' ? 'default' : 'destructive'}
              size="sm"
              onClick={() => {
                onConfirm(control)
              }}
            >
              {control.kind === 'resume'
                ? 'Confirm resume'
                : control.kind === 'remove-agent'
                  ? 'Confirm remove'
                  : 'Confirm stop'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={GHOST_BTN}
              onClick={onCancel}
            >
              Cancel
            </Button>
            <span className={CTRL_NOTE}>disarms on its own in {RC_ARM_MS / 1000}s</span>
          </div>
        </>
      )}
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
function working(session: Pick<ClaudeSession, 'status' | 'lastActivityAt'>): boolean {
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
