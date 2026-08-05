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

import { useState } from 'react'

import { Bar } from './skeleton'
import { Segmented } from './ui'

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
 */
export function grafanaLogsEmbed(container: string, from = "now-7d"): string {
  return (
    `${GRAFANA}/d-solo/container-logs/container-logs` +
    `?panelId=1&var-container=${encodeURIComponent(container)}` +
    `&from=${from}&to=now&theme=dark&refresh=30s`
  )
}

/** The full Drilldown, for when you need search and live tail. */
export function grafanaLogsFull(container: string, from = "now-7d"): string {
  return (
    `${GRAFANA}/a/grafana-lokiexplore-app/explore` +
    `?from=${from}&to=now&var-ds=loki-default` +
    `&var-filters=${encodeURIComponent(`container|=|${container}`)}`
  )
}

/**
 * The ranges worth one click.
 *
 * `d-solo` renders a panel with no time picker — that is the whole reason it
 * is the right URL, since the picker comes attached to Grafana's entire
 * toolbar. So the picker is ours: four ranges, swapped into the iframe's src,
 * which is a page-local reload of one frame rather than a route change.
 */
const RANGES = [
  { value: 'now-1h', label: '1h' },
  { value: 'now-24h', label: '24h' },
  { value: 'now-7d', label: '7d' },
  { value: 'now-30d', label: '30d' },
] as const

type Range = (typeof RANGES)[number]['value']

/**
 * The frame, held back until Grafana has actually booted inside it.
 *
 * Grafana's index shell ships a PRELOADER — a bouncing, squashing Grafana
 * logo on `animation-iteration-count: infinite` plus a fading caption — that
 * runs from first paint until its JS mounts the panel. In a full-page tab
 * nobody minds. In a 22rem box on a dashboard it is a large animated logo
 * that appears and vanishes on every reload, which is the flashing: it is
 * Grafana's loading state leaking through a hole we cut in our own page.
 *
 * So the iframe starts transparent over our own skeleton and is revealed on
 * `load`, which fires after the embedded document is done. The placeholder
 * says the same thing the preloader did, in the vocabulary the rest of the
 * app already uses — see components/skeleton.tsx.
 *
 * ── the reveal must not depend on us ──────────────────────────────────────
 *
 * `opacity: 0` is in the SSR'd markup, because the browser starts fetching
 * the iframe the moment that markup lands — well before React hydrates, so
 * there is no client-side trick that can get in front of it. That means a
 * page whose JS never runs would hide the frame forever, so the reveal has a
 * CSS backstop: a zero-duration animation with a delay that turns it on
 * regardless. `load` normally wins by several seconds; the timer only ever
 * fires when something else has already gone wrong.
 */
function LogFrame({ src, title }: { src: string; title: string }) {
  const [ready, setReady] = useState(false)

  return (
    <div className="embed-wrap embed-logs">
      {!ready && (
        <div className="embed-skeleton" aria-hidden="true">
          <Bar w="28%" h={10} />
          <Bar w="86%" h={10} />
          <Bar w="72%" h={10} />
          <Bar w="90%" h={10} />
          <Bar w="64%" h={10} />
          <Bar w="80%" h={10} />
        </div>
      )}
      {/* Eager, despite sitting below the fold on every page that has one.
          `loading="lazy"` made this worse rather than better: the load — and
          so the preloader — started at the moment the box scrolled into view,
          so the animation played directly under the eye every single time,
          and a frame that has not begun loading cannot be told apart from one
          that is still loading. Fetching it with the page means it is booted
          before you arrive, and the reveal has something real to reveal. */}
      <iframe
        className={ready ? 'embed is-ready' : 'embed'}
        src={src}
        title={title}
        onLoad={() => {
          setReady(true)
        }}
      />
    </div>
  )
}

export function GrafanaLogs({ container, title }: { container: string; title: string }) {
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
          href={grafanaLogsFull(container, from)}
          target="_blank"
          rel="noreferrer"
        >
          ↗ Search
        </a>
      </div>
      {/* `key` on the range so a change remounts the frame rather than
          mutating src — Grafana keeps its own history otherwise, and the back
          button would start walking through time ranges instead of pages. The
          key also resets the frame's own loaded state, so a range change gets
          the same quiet placeholder a reload does. */}
      <LogFrame key={from} src={grafanaLogsEmbed(container, from)} title={title} />
      <p className="board-foot">
        Rendered by Grafana from <code>{container}</code>, newest first. The default is seven days
        because most services here are quiet between restarts — a short window shows nothing for a
        service that is perfectly healthy. If the frame shows a login screen, open Grafana once in
        a tab: it needs a session it cannot obtain inside itself, because the IdP refuses to be
        framed.
      </p>
    </>
  )
}
