// Log lines, rendered by Grafana rather than by us.
//
// This app used to draw its own: a `<div>` per line with a level class. That
// is fine until you want the things you actually want from logs — search,
// level filtering, a time range you can drag, live tail, context around a
// line, copy-with-timestamps — every one of which Grafana already has and
// took years to get right. The hand-rolled list was never going to catch up,
// and two half-implementations of it (one here, one on the Gaming page) was
// the point at which that stopped being a reasonable trade.
//
// ── which Grafana URL, and why it matters ─────────────────────────────────
//
// `/d-solo` renders ONE PANEL and nothing else. The Logs Drilldown app —
// `/a/grafana-lokiexplore-app` — is an investigation surface that brings its
// own label editor, datasource selector, time picker and histogram; `&kiosk`
// does not strip any of that, because none of it is Grafana's chrome. In a
// card, d-solo is the only sensible one.
//
// The panel comes from the `container-logs` dashboard provisioned by
// stacks/monitoring, whose sole variable is the container name — so a caller
// only ever supplies that, and every embed on this box stays identical.
//
// ── the session caveat, stated rather than discovered ─────────────────────
//
// The frame needs a Grafana session it cannot obtain inside itself: Grafana
// auto-logs-in through Pocket ID, and Pocket ID sends `frame-ancestors 'none'`
// so its page refuses to render in an iframe. Opening Grafana once in a tab
// is enough, and the caption says so rather than leaving a login box to be
// puzzled over.

import { useEffect, useState, type ReactNode } from 'react'

import { Bar } from './skeleton'
import { Segmented } from './ui'
import { Board } from './viz'

const GRAFANA = 'https://grafana.toscanini.me'

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
 * ── no `refresh` ──────────────────────────────────────────────────────────
 *
 * This used to carry `&refresh=30s`, and that is half of what made the frame
 * flicker. Grafana does not re-query a panel quietly: every tick it paints a
 * centred "Loading ..." spinner over the panel body for about a tenth of a
 * second before the rows come back. Once every thirty seconds for as long as
 * the page was open — visible in traefik's log as query bursts at a
 * metronomic 29-30s spacing — and, because the timer is suspended while the
 * tab is hidden and fires on the way back, guaranteed to greet you the
 * moment you alt-tab in. It reads as the panel breaking and recovering.
 *
 * Refresh bought nothing to pay for it. The window this opens on is SEVEN
 * DAYS: a line arriving thirty seconds ago moves the view by well under a
 * pixel. Anyone actually tailing a service wants the Drilldown behind the
 * Search button, which has live tail and a great deal else this frame does
 * not. Changing the range here already reloads the panel, and so does
 * reloading the page.
 *
 * With it gone the frame renders exactly once per mount, which is what makes
 * the first-load cover below sufficient rather than a band-aid.
 */
export function grafanaLogsEmbed(source: LogSource, from = "now-7d"): string {
  return (
    `${GRAFANA}/d-solo/container-logs/container-logs` +
    `?panelId=1&var-selector=${encodeURIComponent(`${label(source)}="${value(source)}"`)}` +
    `&from=${from}&to=now&theme=dark`
  )
}

/** The full Drilldown, for when you need search and live tail. */
export function grafanaLogsFull(source: LogSource, from = "now-7d"): string {
  return (
    `${GRAFANA}/a/grafana-lokiexplore-app/explore` +
    `?from=${from}&to=now&var-ds=loki-default` +
    `&var-filters=${encodeURIComponent(`${label(source)}|=|${value(source)}`)}`
  )
}

/**
 * Which Loki stream to show.
 *
 * `container` is the ordinary case: everything on this box logs to journald and
 * alloy labels it with the podman container name. `stack` exists for the one
 * service whose logs did not come from this box's journal at all — Lemonade
 * runs on the gaming PC and reaches Loki through the WebSocket bridge in
 * stacks/lemonade-logs, which pushes directly and therefore has no container
 * to be named after. `unit` is for host plumbing that is not containerised at
 * all: ddclient and pi-hole are NixOS services, so their lines carry a
 * systemd unit label and no container one. A union rather than three optional
 * fields, so a caller cannot pass two and leave the query to guess.
 */
export type LogSource = { container: string } | { stack: string } | { unit: string }

const label = (s: LogSource) =>
  'container' in s ? 'container'
  : 'stack' in s ? 'stack'
  : 'unit'
const value = (s: LogSource) =>
  'container' in s ? s.container
  : 'stack' in s ? s.stack
  : s.unit

/**
 * The ranges worth one click.
 *
 * `d-solo` renders a panel with no time picker — that is the whole reason it
 * is the right URL, since the picker comes attached to Grafana's entire
 * toolbar. So the picker is ours: four ranges, swapped into the iframe's src,
 * which is a page-local reload of one frame rather than a route change.
 */
const RANGES = [
  { value: 'now-1h', label: '1h', settle: 1_200 },
  { value: 'now-24h', label: '24h', settle: 1_200 },
  { value: 'now-7d', label: '7d', settle: 1_200 },
  // Three times the others, and the reason is the opposite of the obvious
  // one. Loki walks BACKWARDS from `now` and stops at the panel's 1000-line
  // limit, so a chatty container fills the quota in the first few hours and
  // answers a 30-day question as fast as a one-hour one — traefik and pg both
  // come back in 25-70ms at either width. A QUIET container never fills it,
  // so Loki has to scan all thirty days of chunks to prove there is nothing
  // more: factorio takes 1346ms at 30d against 369ms at 7d, for 304 lines.
  //
  // So the wide window is slow exactly where there is least to show, which is
  // most of this box. Grafana boots, then issues that query, then renders —
  // and 1200ms of cover ran out in the middle of it, which is why this was
  // the one range still flickering.
  { value: 'now-30d', label: '30d', settle: 3_000 },
] as const

type Range = (typeof RANGES)[number]['value']

const SETTLE = new Map<string, number>(RANGES.map((r) => [r.value, r.settle]))

/**
 * The ceiling, for when `load` never arrives at all — Grafana down, the
 * session missing, the network gone. The frame is uncovered regardless so
 * whatever Grafana IS showing (a login screen, an error) becomes visible and
 * can be acted on. A cover that outlives its content is just a hidden fault.
 *
 * Comfortably above the largest `settle` so it never pre-empts a frame that
 * is merely being patient.
 */
const REVEAL_CAP_MS = 10_000

/**
 * The frame, covered until Grafana has finished assembling itself.
 *
 * `load` fires when the embedded DOCUMENT is done, which is the START of
 * Grafana's boot, not the end of it. What follows is four visible states —
 * empty panel, a centred "Loading ..." spinner, empty panel again with only
 * the "Powered by Grafana" badge, then the rows. Revealing on `load` would
 * uncover the frame just in time to show all of it, so the cover is held for
 * `settle` milliseconds longer.
 *
 * That number is a guess and cannot be anything else: the frame is
 * cross-origin, d-solo sends no postMessage, and there is no other signal to
 * wait on. But it is a guess that only has to hold ONCE per mount, because
 * with `refresh` gone the panel never renders a second time. If it is short,
 * the cost is bounded — the cover lifts a beat early and you see the tail of
 * Grafana's boot, which is exactly the old behaviour.
 *
 * The cover has to be in the SERVER-rendered markup: the browser begins
 * fetching the iframe the instant that HTML lands, well before React
 * hydrates, so nothing done on mount can get in front of the first paint.
 * That means a page whose JS never runs would keep the frame hidden forever,
 * so the reveal also has a pure-CSS backstop on a longer timer — see
 * `.embed` in styles.css.
 */
function LogFrame({ src, title, settle }: { src: string; title: string; settle: number }) {
  const [loaded, setLoaded] = useState(false)
  const [ready, setReady] = useState(false)

  // Two independent timers, because they answer different questions: one
  // waits out Grafana's boot after a successful load, the other gives up on
  // waiting at all.
  useEffect(() => {
    if (!loaded) return
    const t = setTimeout(() => {
      setReady(true)
    }, settle)
    return () => {
      clearTimeout(t)
    }
  }, [loaded, settle])

  useEffect(() => {
    const t = setTimeout(() => {
      setReady(true)
    }, REVEAL_CAP_MS)
    return () => {
      clearTimeout(t)
    }
  }, [])

  return (
    <div className="embed-wrap embed-logs">
      {!ready && (
        <div className="embed-skeleton" aria-hidden="true">
          <Bar w="26%" h={10} />
          <Bar w="88%" h={10} />
          <Bar w="71%" h={10} />
          <Bar w="93%" h={10} />
          <Bar w="62%" h={10} />
          <Bar w="80%" h={10} />
        </div>
      )}
      {/* Eager, despite sitting below the fold. `loading="lazy"` starts the
          fetch as the box scrolls into view, which puts Grafana's boot — and
          so this cover — directly under the eye at the moment you arrive.
          Fetching with the page means the wait is spent while you are reading
          something else. */}
      <iframe
        className={ready ? 'embed is-ready' : 'embed'}
        src={src}
        title={title}
        onLoad={() => {
          setLoaded(true)
        }}
      />
    </div>
  )
}

/**
 * A second log stream, folded away until it is wanted.
 *
 * For the containers standing NEXT to a service — the bridge shipping its
 * lines, the tool servers its gateway proxies. They belong on the page (the day
 * the main panel goes quiet, one of these is why) and they do not belong open
 * (on every other day they are noise under the log you came for).
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
      className="sublog"
      onToggle={(e) => {
        if (e.currentTarget.open) setSeen(true)
      }}
    >
      <summary>{summary}</summary>
      {seen && <GrafanaLogs source={source} title={title} foot={foot} />}
    </details>
  )
}

/**
 * A container standing beside the tab's subject, with no page of its own.
 *
 * The light kind of neighbour: something whose only question is "what did it
 * say". flaresolverr solving a challenge for an indexer, subgen transcribing
 * an episode, recyclarr writing a profile — each is a plausible answer to "it
 * failed and its own log only blamed its upstream", and none is worth a tab.
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
   * and the version snapshot behind Shelfmark's and Recyclarr's numbers is
   * exactly that. A neighbour is defined by "you would come looking here when
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
  return 'container' in s ? s.container : 'unit' in s ? s.unit : s.stack
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
    <Board title="Logs" icon="≡" span={12}>
      <GrafanaLogs source={source} title={title} foot={foot} />
      {neighbours.map((n) => (
        <LogDetails
          key={sourceKey(n.source)}
          summary={`${n.label} — ${n.role}`}
          source={n.source}
          title={n.title ?? `${n.label} logs`}
          foot={<p className="board-foot">{n.note}</p>}
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
  // Seven days for the reason in grafanaLogsEmbed: most services here are
  // quiet between restarts, and a short default shows nothing for a healthy
  // one.
  const [from, setFrom] = useState<Range>('now-7d')

  return (
    <>
      <div className="logs-bar">
        <Segmented
          value={from}
          onChange={setFrom}
          options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
        />
        <a
          className="btn btn-ghost"
          href={grafanaLogsFull(source, from)}
          target="_blank"
          rel="noreferrer"
        >
          ↗ Search
        </a>
      </div>
      {/* `key` on the range so a change remounts the frame rather than
          mutating src — Grafana keeps its own history otherwise, and the back
          button would start walking through time ranges instead of pages. It
          also resets the cover, so switching range gets the same skeleton the
          first load does rather than Grafana's boot in the raw. */}
      <LogFrame
        key={from}
        src={grafanaLogsEmbed(source, from)}
        title={title}
        settle={SETTLE.get(from) ?? 1_200}
      />
      {foot ?? (
        <p className="board-foot">
          Rendered by Grafana from <code>{value(source)}</code>, newest first. The default is seven
          days because most services here are quiet between restarts — a short window shows nothing
          for a service that is perfectly healthy. If the frame shows a login screen, open Grafana
          once in a tab: it needs a session it cannot obtain inside itself, because the IdP refuses
          to be framed.
        </p>
      )}
    </>
  )
}
