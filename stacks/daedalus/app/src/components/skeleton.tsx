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

/**
 * The service header: artwork, name, version, lede, and the button.
 *
 * Reserved rather than left to arrive, for the first rule above. Nearly every
 * tab on this dashboard opens with a `ServiceHead`, and without a placeholder
 * the whole board grid renders at the top of the page and is then pushed down
 * by ~80px the moment the loader resolves — at exactly the moment you have
 * started reading the first board.
 *
 * Which tabs get one is declared on the tab (`CategorySpec.tabs[].head`), not
 * guessed here: the placeholder has to know before the data exists, and the
 * System layers genuinely have no service to head.
 */
export function ServiceHeadSkeleton() {
  return (
    <div className="svc-head">
      <span className="sk svc-logo" />
      <div className="sk-ident">
        <Bar w="22%" h={18} />
        <Bar w="34%" h={11} />
        <Bar w="72%" h={12} />
      </div>
    </div>
  )
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

/** The strip of live readings at the top of an app detail tab. */
export function StripSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="strip">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="stat">
          <Bar w="55%" h={9} />
          <Bar w="70%" h={20} />
          <Bar w="85%" h={10} />
        </div>
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
