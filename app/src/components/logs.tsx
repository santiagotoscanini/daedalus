// Log lines, rendered by Grafana rather than by us: search, level filtering,
// live tail, context around a line — Grafana already has all of it, and a
// hand-rolled list never catches up.
//
// ── which Grafana URL, and why it matters ─────────────────────────────────
//
// `/d-solo` renders ONE PANEL and nothing else. The Logs Drilldown app —
// `/a/grafana-lokiexplore-app` — is an investigation surface that brings its
// own label editor, datasource selector, time picker and histogram; `&kiosk`
// does not strip any of that, because none of it is Grafana's chrome. In a
// card, d-solo is the only sensible one; the Drilldown is the Search button.
//
// The panel comes from the `container-logs` dashboard the monitoring module
// provisions (nix/modules/monitoring/assets/dashboards/container-logs.json),
// whose sole variable is a raw Loki label matcher — so a caller only ever
// supplies a `LogSource`, and every embed stays identical.
//
// ── the session caveat, stated rather than discovered ─────────────────────
//
// The frame needs a Grafana session it cannot obtain inside itself: Grafana
// auto-logs-in through Pocket ID, and Pocket ID sends `frame-ancestors 'none'`
// so its page refuses to render in an iframe. Opening Grafana once in a tab
// is enough, and the caption says so rather than leaving a login box to be
// puzzled over.

import { type ReactNode, useState } from 'react'

import { cn } from '../lib/cn'
import { type ResolvedScheme, useScheme } from '../lib/scheme'
import type { Site } from '../lib/site'
import { useSite } from '../lib/site-context'
import { GHOST_BTN } from './apps/shared'
import { Segmented } from './controls'
import { LogFrame } from './log-frame'
import { CAPTION, FOOT } from './tokens'
import { Button } from './ui/button'
import { Board } from './viz'

/* `LogDetails`' box. Stacked, they are a list of sibling streams — the rule
   between them is enough separation, so the gap above is dropped between
   neighbours. The range bar inside only needs the breathing room the summary
   does not provide. */
const SUBLOG = 'group mt-2 border-hairline border-t pt-3 [&+&]:mt-0 [&>summary+div]:mt-3'
const SUBLOG_SUMMARY = cn(
  'flex cursor-pointer list-none items-center gap-1.5 text-[0.78rem] text-muted-foreground transition-colors',
  'hover:text-foreground [&::-webkit-details-marker]:hidden',
  "before:text-[0.72rem] before:transition-transform before:duration-[0.12s] before:content-['▸']",
  'group-open:before:rotate-90',
)

/**
 * One panel out of the provisioned dashboard, filtered to one container.
 *
 * The window defaults to SEVEN DAYS, and that is not laziness. Most things
 * here are quiet: an app logs its migrations and "listening on" at start and
 * then nothing until it is restarted, so a few hours of silence is the normal
 * state rather than a fault. A short window renders "No data" over a service
 * whose lines are sitting in Loki three days old — which reads as a broken
 * log pipeline and sends you debugging the wrong thing.
 *
 * It costs nothing to be wide: the panel sorts newest-first, so a chatty
 * container still opens on its most recent line.
 *
 * ── no `&refresh=` ────────────────────────────────────────────────────────
 *
 * Grafana does not re-query a panel quietly: every tick paints a centred
 * "Loading ..." spinner over the rows, and a timer suspended in a hidden tab
 * fires the moment you come back to it — it reads as the panel breaking and
 * recovering. It would buy nothing: on a seven-day window a new line moves the
 * view by under a pixel, live tail is the Drilldown behind Search, and a range
 * change remounts the frame anyway.
 *
 * Rendering once per mount is what makes `LogFrame`'s one-shot cover enough.
 */
function grafanaLogsEmbed(
  site: Site,
  source: LogSource,
  from = 'now-7d',
  theme: ResolvedScheme = 'dark',
): string {
  return (
    `${site.grafanaUrl}/d-solo/container-logs/container-logs` +
    `?panelId=1&var-selector=${encodeURIComponent(`${label(source)}="${value(source)}"`)}` +
    `&from=${from}&to=now&theme=${theme}`
  )
}

/** The full Drilldown, for when you need search and live tail. */
function grafanaLogsFull(site: Site, source: LogSource, from = 'now-7d'): string {
  return (
    `${site.grafanaUrl}/a/grafana-lokiexplore-app/explore` +
    `?from=${from}&to=now&var-ds=loki-default` +
    `&var-filters=${encodeURIComponent(`${label(source)}|=|${value(source)}`)}`
  )
}

/**
 * Which Loki stream to show.
 *
 * The three labels alloy puts on a journal line (nix/modules/logging).
 * `container` is the ordinary case: the podman container name. `stack` groups
 * several containers under one name (`fleet.logStacks`: `nextcloud`, `immich`,
 * `app-db`), and also covers streams with no container at all — `kernel`, and
 * `lemonade`, which a bridge pushes into Loki from another machine. `unit` is
 * a systemd unit: native services (`pihole-ftl.service`, `ddclient.service`)
 * and the oneshots around a stack. `job` is a log FILE a stack ships beside its
 * journal (alloy `job` label: an agent's own gateway/errors files). A union rather
 * than optional fields, so a caller cannot pass two and leave the query to guess.
 */
export type LogSource =
  | { container: string }
  | { stack: string }
  | { unit: string }
  | { job: string }

const label = (s: LogSource) =>
  'container' in s ? 'container' : 'stack' in s ? 'stack' : 'job' in s ? 'job' : 'unit'
const value = (s: LogSource) =>
  'container' in s ? s.container : 'stack' in s ? s.stack : 'job' in s ? s.job : s.unit

/**
 * The ranges worth one click.
 *
 * `d-solo` renders a panel with no time picker — that is the whole reason it
 * is the right URL, since the picker comes attached to Grafana's entire
 * toolbar. So the picker is ours: four ranges, each a remount of the one
 * frame (see the `key` in GrafanaLogs) rather than a route change.
 *
 * `settle` is how long `LogFrame` keeps the cover on after `load`.
 */
const RANGES = [
  { value: 'now-1h', label: '1h', settle: 1_200 },
  { value: 'now-24h', label: '24h', settle: 1_200 },
  { value: 'now-7d', label: '7d', settle: 1_200 },
  // Three times the others, and the reason is the opposite of the obvious
  // one. Loki walks BACKWARDS from `now` and stops at the datasource's
  // 1000-line `maxLines`, so a chatty container fills the quota in the first few hours and
  // answers a 30-day question as fast as a one-hour one — traefik and pg both
  // come back in 25-70ms at either width. A QUIET container never fills it,
  // so Loki has to scan all thirty days of chunks to prove there is nothing
  // more: factorio takes 1346ms at 30d against 369ms at 7d, for 304 lines.
  //
  // So the wide window is slow exactly where there is least to show, which is
  // most of this box. Grafana boots, then issues that query, then renders —
  // and 1200ms of cover runs out in the middle of it.
  { value: 'now-30d', label: '30d', settle: 3_000 },
] as const

type Range = (typeof RANGES)[number]['value']

const SETTLE = new Map<string, number>(RANGES.map((r) => [r.value, r.settle]))

/**
 * A second log stream, folded away until it is wanted.
 *
 * For the streams standing NEXT to a service — the bridge shipping its lines,
 * the oneshot that renders its config. They belong on the page (the day the
 * main panel goes quiet, one of these is why) and they do not belong open (on
 * every other day they are noise under the log you came for). `LogBoard`
 * renders one per neighbour; the IdP page uses it directly.
 *
 * ── why the frame is mounted on open rather than hidden ───────────────────
 *
 * Because a `<details>` that is closed is `display: none`, and an iframe with
 * no box is an iframe Grafana lays out at 0x0. Rendering it up-front meant the
 * panel booted, queried and drew itself against nothing, and the cover in
 * `LogFrame` — which is timed from `load` — was long spent by the time you
 * opened the thing. So you got Grafana's whole boot sequence, uncovered, in the
 * one place that had gone to the trouble of hiding it. Mounting on first open
 * starts that cycle with the box at its real size, which is all `LogFrame`
 * needed to work here the way it works everywhere else.
 *
 * A latch rather than the raw open state: once mounted it STAYS mounted through
 * a close, so toggling twice does not re-run a Loki query that is already
 * answered. Loki runs few queries at once here and these are the cheap panels
 * on a page that has already asked it several questions.
 */
export function LogDetails({
  summary,
  source,
  title,
  foot,
}: {
  summary: ReactNode
  source: LogSource
  title: string
  foot?: ReactNode
}) {
  const [seen, setSeen] = useState(false)

  return (
    <details
      className={SUBLOG}
      onToggle={(e) => {
        if (e.currentTarget.open) setSeen(true)
      }}
    >
      <summary className={SUBLOG_SUMMARY}>{summary}</summary>
      {seen && <GrafanaLogs source={source} title={title} foot={foot} />}
    </details>
  )
}

/**
 * A log stream standing beside the tab's subject, with no page of its own.
 *
 * The light kind of neighbour: something whose only question is "what did it
 * say". flaresolverr solving a challenge for an indexer, subgen transcribing
 * an episode, the snapshot behind a version number — each is a plausible
 * answer to "it failed and its own log only blamed its upstream", and none is
 * worth a tab.
 *
 * What does NOT belong here is a container everybody shares. `pg` is behind
 * Nextcloud, Immich, the *arrs and every app on the platform; a container that
 * is everyone's neighbour is nobody's.
 */
export type LogNeighbour = {
  /**
   * A container, a systemd unit, or a stack.
   *
   * Not just a container name: some of what a page depends on is a oneshot,
   * and the version snapshot behind the media pages' channel-pinned versions
   * (`VERSION_SNAPSHOT`) is exactly that. A neighbour is defined by "you would come looking here when
   * the panel above went wrong", which has nothing to do with whether the
   * thing happens to be a container.
   */
  source: LogSource
  label: string
  /** Completes “<label> — …”, so it says what this thing IS to the tab. */
  role: string
  note: string
  /** Only when the panel heading should differ from `<label> logs`. */
  title?: string
}

/** A stable React key for a neighbour, whichever kind of source it is. */
function sourceKey(s: LogSource): string {
  return 'container' in s ? s.container : 'unit' in s ? s.unit : 'job' in s ? s.job : s.stack
}

/**
 * The logs board: the service's own stream, and its neighbours' underneath.
 *
 * One component rather than a `<Board>` per page because the argument is the
 * same everywhere — the subject's log is open, everything adjacent to it is one
 * disclosure away — and a page that made a different call about that would be a
 * page you have to learn separately.
 */
export function LogBoard({
  source,
  title,
  foot,
  neighbours = [],
}: {
  source: LogSource
  title: string
  foot?: ReactNode
  neighbours?: readonly LogNeighbour[]
}) {
  return (
    <Board title="Logs" icon="logs" span={12}>
      <GrafanaLogs source={source} title={title} foot={foot} />
      {neighbours.map((n) => (
        <LogDetails
          key={sourceKey(n.source)}
          summary={`${n.label} — ${n.role}`}
          source={n.source}
          title={n.title ?? `${n.label} logs`}
          foot={<p className={FOOT}>{n.note}</p>}
        />
      ))}
    </Board>
  )
}

export function GrafanaLogs({
  source,
  title,
  /** Replaces the default caption where the default would be wrong. */
  foot,
}: {
  source: LogSource
  title: string
  foot?: ReactNode
}) {
  const site = useSite()
  // Seven days for the reason in grafanaLogsEmbed: most services here are
  // quiet between restarts, and a short default shows nothing for a healthy
  // one.
  const [from, setFrom] = useState<Range>('now-7d')
  const scheme = useScheme()

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={from}
          onChange={setFrom}
          label="Log range"
          className="max-[40rem]:min-h-10 max-[40rem]:[&_button]:min-h-9"
          options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
        />
        <Button asChild variant="outline" size="sm" className={GHOST_BTN}>
          <a
            className="whitespace-nowrap"
            href={grafanaLogsFull(site, source, from)}
            target="_blank"
            rel="noreferrer"
          >
            Search ↗
          </a>
        </Button>
      </div>
      {/* `key` on the range and the scheme so a change remounts the frame
          rather than mutating src — an iframe navigation lands in the page's
          history otherwise, and the back button would start walking through
          time ranges instead of pages. It also resets the cover, so a switch
          gets the same skeleton the first load does. */}
      <LogFrame
        key={`${from}-${scheme}`}
        src={grafanaLogsEmbed(site, source, from, scheme)}
        title={title}
        settle={SETTLE.get(from) ?? 1_200}
      />
      {foot ?? (
        <>
          <p className={CAPTION}>
            Rendered by Grafana from <code>{value(source)}</code>, newest first.
          </p>
          <p className={FOOT}>
            The default is seven days because most services here are quiet between restarts, and a
            short window shows nothing for a service that is perfectly healthy. If the frame shows a
            login screen, open Grafana once in a tab: it needs a session it cannot obtain inside
            itself, because the IdP refuses to be framed.
          </p>
        </>
      )}
    </div>
  )
}
