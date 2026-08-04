// Topology diagrams — what talks to what, and what is moving between them.
//
// The category pages answer "how much" well and "through what" not at all. A
// number like "375k tokens from n8n" tells you nothing about the fact that n8n
// reaches Lemonade only through LiteLLM, or that the Cloudflare tunnel needs
// no forwarded port while WireGuard does. Those are the facts you actually
// need at 2am, and they are shape, not magnitude.
//
// ── why this is hand-rolled ───────────────────────────────────────────────
//
// React Flow is the obvious library and is the wrong tool here. It is a node
// EDITOR: pan, zoom, drag, connect. On a scrolling dashboard that means
// hijacked scroll on a phone, and these graphs are fixed — nobody is going to
// rewire the media pipeline by dragging a box. Its SSR mode also requires
// hand-supplying every node's width, height, handle positions and the
// container size, which is the whole of the geometry — so the thing it would
// save is the thing you have to write anyway, and these pages stream their
// content from the server (see routes/c.$category.tsx). A library that renders
// nothing until hydration would put a blank rectangle where the diagram is.
//
// ── how the geometry works without measuring anything ─────────────────────
//
// Stages are flex columns; between each pair sits a gap element holding an
// SVG. Node i of n in a column has its centre at (i + 0.5) / n of the column
// height, which is true by construction because the column is a grid with
// equal rows — so an edge's endpoints are computable as fractions with no
// DOM measurement, no layout engine, and no effect that runs after paint.
// The SVG is `preserveAspectRatio="none"` over a 0-100 box, which is why every
// stroke carries `vector-effect="non-scaling-stroke"`: without it the curves
// would thicken as the gap widened.
//
// ── conventions borrowed from network diagrams ────────────────────────────
//
//   Flow reads one way. Left to right on a wide screen, top to bottom on a
//   narrow one — never both in the same picture.
//   Tiers are columns. Each stage is one layer of the path, titled.
//   Trust boundaries are dashed. Consecutive stages in the same zone sit
//   inside one dashed container: "the internet", "this house", "this box".
//   Edges are labelled with what crosses them — a protocol, a port, a rate.
//   Motion means traffic. A marching-ants edge is one with something on it
//   right now; a still edge is a path that exists and is idle.

import { Fragment, type ReactNode } from 'react'
import type { Tone } from './viz'

export type TopoNode = {
  id: string
  label: string
  /** Makes the whole box a link to the thing it represents. */
  href?: string
  /** One line under the name — what the thing is. */
  sub?: string
  icon?: string
  tone?: Tone
  /** Readings shown inside the box. Keep to three; this is a diagram. */
  facts?: { k: string; v: string }[]
  /** Something is happening in this node right now. */
  live?: boolean
  /** Declared but not carrying anything — drawn dimmer. */
  idle?: boolean
}

export type TopoStage = {
  id: string
  title: string
  /** Trust boundary. Consecutive stages sharing one are drawn inside it. */
  zone?: string
  nodes: TopoNode[]
  /**
   * Services that act ON this step without being a step of their own —
   * Cleanuparr watching the queue, Recyclarr writing profiles in, Pocket ID
   * being asked. Drawn on a second row below the main line and tied to it by
   * a stub, so the eye reads the pipeline without them and then finds them.
   */
  aside?: { node: TopoNode; label?: string; tone?: Tone }[]
}

export type TopoEdge = {
  from: string
  to: string
  /** What crosses this edge: a protocol, a port, a rate. */
  label?: string
  tone?: Tone
  /** Traffic on it right now — the only thing that animates. */
  active?: boolean
  /** Draw dashed: a path that exists conditionally or carries nothing. */
  dashed?: boolean
}

export function Topology({
  stages,
  edges,
  foot,
}: {
  stages: TopoStage[]
  edges: TopoEdge[]
  foot?: ReactNode
}) {
  // Which column each node sits in, and where in that column. Both are needed
  // to place an edge, and both are pure functions of the stage list.
  const place = new Map<string, { stage: number; index: number; of: number }>()
  stages.forEach((s, si) =>
    s.nodes.forEach((n, ni) => place.set(n.id, { stage: si, index: ni, of: s.nodes.length })),
  )

  // Edges belong to the gap after their source column. An edge that skips a
  // column is dropped rather than drawn wrong — these graphs are authored, so
  // that is a bug in the authoring, and a line to nowhere would hide it.
  const gaps = stages.slice(0, -1).map((_, gi) =>
    edges.filter((e) => {
      const a = place.get(e.from)
      const b = place.get(e.to)
      return a !== undefined && b !== undefined && a.stage === gi && b.stage === gi + 1
    }),
  )

  // Consecutive stages sharing a zone are one container. A graph with no zones
  // at all is therefore a single group, which matters for alignment: gaps
  // inside a group and gaps between groups sit at different offsets.
  const groups: { zone?: string; from: number; to: number }[] = []
  stages.forEach((s, i) => {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.zone === s.zone) last.to = i
    else groups.push({ zone: s.zone, from: i, to: i })
  })

  return (
    <div className="topo-wrap">
      <div className="topo">
        {groups.map((g, gi) => (
          // A boundary-crossing edge is drawn BETWEEN the dashed boxes, not
          // inside one of them: the dashed border has to end at the last node
          // of its zone or it stops meaning "this is the edge of the zone".
          <Fragment key={`${g.zone ?? ''}-${String(g.from)}`}>
            <div className="topo-group">
              {g.zone !== undefined && <span className="topo-zone">{g.zone}</span>}
              <div className="topo-group-body">
                {stages.slice(g.from, g.to + 1).map((s, si) => (
                  <Fragment key={s.id}>
                    <Stage stage={s} />
                    {si < g.to - g.from && <Gap edges={gaps[g.from + si] ?? []} place={place} />}
                  </Fragment>
                ))}
              </div>
            </div>
            {gi < groups.length - 1 && <Gap edges={gaps[g.to] ?? []} place={place} outer />}
          </Fragment>
        ))}
      </div>
      {foot !== undefined && <p className="board-foot">{foot}</p>}
    </div>
  )
}

function Stage({ stage }: { stage: TopoStage }) {
  return (
    <div className="topo-stage">
      <h5 className="topo-stage-title">{stage.title}</h5>
      <div className="topo-nodes">
        {stage.nodes.map((n) => (
          <Node key={n.id} node={n} />
        ))}
      </div>
      {stage.aside !== undefined && stage.aside.length > 0 && (
        <div className="topo-aside">
          {stage.aside.map((a) => (
            <div key={a.node.id} className={`topo-branch topo-branch-${a.tone ?? 'muted'}`}>
              {/* The stub is the whole point of a branch: it says "this hangs
                  off the line above" rather than "this is the next step". */}
              <span className="topo-stub" aria-hidden="true" />
              {a.label !== undefined && <span className="topo-branch-label">{a.label}</span>}
              <Node node={a.node} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Node({ node }: { node: TopoNode }) {
  const cls =
    `topo-node topo-${node.tone ?? 'muted'}` +
    (node.idle === true ? ' topo-node-idle' : '') +
    (node.href !== undefined ? ' topo-node-link' : '')

  // A node standing for something with a UI becomes a link to it. The diagram
  // is where you work out WHICH service is the problem; the click after that
  // should not be a second hunt through the tile list below.
  if (node.href !== undefined) {
    return (
      <a className={cls} href={node.href} target="_blank" rel="noreferrer">
        <Body node={node} />
      </a>
    )
  }
  return (
    <article className={cls}>
      <Body node={node} />
    </article>
  )
}

function Body({ node }: { node: TopoNode }) {
  return (
    <>
      <header>
        {node.icon !== undefined && (
          <span className="topo-icon" aria-hidden="true">
            {node.icon}
          </span>
        )}
        <strong>{node.label}</strong>
        {node.href !== undefined && (
          <span className="topo-open" aria-hidden="true">
            ↗
          </span>
        )}
        {node.live === true && <span className="topo-live" aria-label="active" />}
      </header>
      {node.sub !== undefined && <p className="topo-sub">{node.sub}</p>}
      {node.facts !== undefined && node.facts.length > 0 && (
        <dl className="topo-facts">
          {node.facts.map((f) => (
            <div key={f.k}>
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  )
}

/**
 * The space between two columns, and everything crossing it.
 *
 * Two renderings of the same edges, one shown at a time by CSS: curves on a
 * wide screen, and on a narrow one a single rail with the labels stacked
 * beside it. A phone cannot show four crossing beziers legibly, and a diagram
 * that is unreadable is worse than a list.
 */
function Gap({
  edges,
  place,
  outer,
}: {
  edges: TopoEdge[]
  place: Map<string, { stage: number; index: number; of: number }>
  outer?: boolean
}) {
  const y = (id: string): number => {
    const p = place.get(id)
    if (p === undefined) return 50
    return ((p.index + 0.5) / p.of) * 100
  }

  return (
    <div className={outer === true ? 'topo-gap topo-gap-outer' : 'topo-gap'}>
      <svg
        className="topo-lines"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {edges.map((e) => {
          const y1 = y(e.from)
          const y2 = y(e.to)
          return (
            <path
              key={`${e.from}-${e.to}`}
              className={[
                'topo-edge',
                `topo-edge-${e.tone ?? 'muted'}`,
                e.active === true ? 'topo-edge-live' : '',
                e.dashed === true ? 'topo-edge-dashed' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              d={`M0,${y1.toFixed(2)} C50,${y1.toFixed(2)} 50,${y2.toFixed(2)} 100,${y2.toFixed(2)}`}
              vectorEffect="non-scaling-stroke"
              fill="none"
            />
          )
        })}
      </svg>

      {/* Wide screens: labels float over the curves. Narrow: they become the
          rail's contents, which is why they are one list rather than two. */}
      <div className="topo-labels">
        {edges
          .filter((e) => e.label !== undefined)
          .map((e) => (
            <span
              key={`${e.from}-${e.to}`}
              className={`topo-label topo-label-${e.tone ?? 'muted'}${
                e.active === true ? ' topo-label-live' : ''
              }`}
            >
              {e.label}
            </span>
          ))}
      </div>
    </div>
  )
}
