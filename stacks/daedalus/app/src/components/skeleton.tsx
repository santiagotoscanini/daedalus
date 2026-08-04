// Placeholders for content that has not arrived yet.
//
// Every page here is a fan-out across a dozen services, and the loader used to
// hold the whole navigation until the slowest one answered. Now the shell
// renders immediately and each region streams in behind one of these, so a
// click always produces a page.
//
// Three rules:
//
//   A skeleton occupies the SHAPE the real thing will take. If the panel is
//   four stat cards over a 12-column grid, so is its placeholder — otherwise
//   the page jumps when data lands, which is worse than a blank wait because
//   you have already started reading.
//
//   It never shows a plausible value. No zeroes, no dashes, no "loading…" in a
//   slot that will hold a number: grey blocks only. A dashboard whose empty
//   state is indistinguishable from a real reading is the one bug none of this
//   is allowed to have.
//
//   The shimmer is the only unconditional animation in the app. Everything
//   else here moves because something is happening; this moves because nothing
//   has happened yet, which is exactly what it needs to say.

/** One grey block. `w` is any CSS length — a percentage reads best in a grid. */
export function Bar({ w = '100%', h = 12 }: { w?: string; h?: number }) {
  return <span className="sk" style={{ width: w, height: h }} />
}

export function StatBandSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="statband">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bigstat sk-card">
          <Bar w="45%" h={9} />
          <Bar w="70%" h={26} />
          <Bar w="60%" h={9} />
        </div>
      ))}
    </div>
  )
}

/**
 * The board grid.
 *
 * Spans are passed in rather than assumed so the placeholder matches the real
 * layout of the page being loaded — all five category pages open with a wide
 * board next to a narrow one, and a uniform grid of six would visibly reflow.
 */
export function BoardsSkeleton({ spans = [8, 4, 6, 6] }: { spans?: number[] }) {
  return (
    <div className="board-grid">
      {spans.map((span, i) => (
        <section key={i} className="board" style={{ ['--span' as string]: String(span) }}>
          <header className="board-head">
            <Bar w="35%" h={11} />
          </header>
          <div className="board-body sk-body">
            <Bar w="100%" h={64} />
            <Bar w="90%" h={12} />
            <Bar w="75%" h={12} />
            <Bar w="82%" h={12} />
          </div>
        </section>
      ))}
    </div>
  )
}

/** The per-service directory under a category's own panels. */
export function TilesSkeleton({ groups = 1, tiles = 5 }: { groups?: number; tiles?: number }) {
  return (
    <>
      {Array.from({ length: groups }, (_, g) => (
        <section key={g} className="tile-group">
          <h2 className="tile-group-head">
            <Bar w="9rem" h={12} />
          </h2>
          <div className="tile-grid">
            {Array.from({ length: tiles }, (_, i) => (
              <article key={i} className="tile sk-card">
                <Bar w="55%" h={13} />
                <Bar w="80%" h={10} />
                <Bar w="100%" h={30} />
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

/** The metric row at the top of an app detail tab. */
export function MetricsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="metrics">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="metric sk-card">
          <Bar w="40%" h={9} />
          <Bar w="55%" h={22} />
          <Bar w="100%" h={30} />
        </div>
      ))}
    </div>
  )
}

export function PanelsSkeleton({ count = 3, rows = 4 }: { count?: number; rows?: number }) {
  return (
    <div className="panels">
      {Array.from({ length: count }, (_, i) => (
        <section key={i} className="panel sk-card">
          <Bar w="30%" h={11} />
          {Array.from({ length: rows }, (_, r) => (
            <Bar key={r} w={`${String(95 - r * 7)}%`} h={11} />
          ))}
        </section>
      ))}
    </div>
  )
}

/** The app list on /apps, and anything else that is a stack of equal rows. */
export function RowsSkeleton({ count = 3, height = 58 }: { count?: number; height?: number }) {
  return (
    <ul className="app-list">
      {Array.from({ length: count }, (_, i) => (
        <li key={i}>
          <div className="sk-row" style={{ height }}>
            <Bar w="0.6rem" h={10} />
            <Bar w="30%" h={14} />
            <Bar w="22%" h={11} />
            <Bar w="12%" h={11} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** A single free-form block, for tabs whose shape is one long list. */
export function BlockSkeleton({ h = 240 }: { h?: number }) {
  return <div className="sk-block" style={{ height: h }} />
}
