import { Await, createFileRoute, Link, notFound } from '@tanstack/react-router'

import { AiView } from '../components/category/ai'
import { HomeView } from '../components/category/home'
import { BooksView, TvView } from '../components/category/media'
import { GamingView } from '../components/category/gaming'
import { MonitoringView } from '../components/category/monitoring'
import { NetworkView } from '../components/category/network'
import { SystemView } from '../components/category/system'
import { BoardsSkeleton, StatBandSkeleton, TilesSkeleton } from '../components/skeleton'
import { CATEGORIES, type CategorySpec } from '../lib/dashboard/nav'
import {
  fetchCategoryBoards,
  fetchCategoryTiles,
  type CategoryPayload,
  type CategoryTiles,
  type Tile,
} from '../server/category'
import type { CategoryName } from '../lib/dashboard/tiles'

// One page per category.
//
// The split is by *subject*, not by service: someone opening Media wants to
// know what is playing and what is downloading, and does not care that those
// two facts come from six containers. So each page leads with panels built
// around the question, and keeps the per-service cards underneath as a
// directory — the cards are where you go to click through to the thing.
//
// ── nothing here blocks the navigation ────────────────────────────────────
//
// The loader returns two UNAWAITED promises. That is the whole design: the
// page frame — title, lede, sub-tabs — comes from the static CATEGORIES table
// and is on screen the instant you click, while the boards and the tiles
// stream in behind their own skeletons. They are genuinely independent
// fan-outs across a dozen services and they finish at different times, so
// making either wait for the other only ever costs.
//
// The router still caches a resolved loader result for `defaultStaleTime`, so
// coming back to a page you just left renders complete, with no skeleton
// flash — the placeholders appear only when something is actually being
// fetched.

export const Route = createFileRoute('/c/$category')({
  // Same reasoning as the app detail page: the sub-tab is in the URL so it
  // survives a refresh, can be linked, and renders on the server.
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  loader: ({ params, deps }) => {
    const spec = CATEGORIES.find((c) => c.id === params.category)
    // An unknown category is a 404, not an empty page: the rail cannot produce
    // one, so anything else got here by hand-editing the URL.
    if (spec === undefined) throw notFound()

    const category = params.category as CategoryName
    const tab = spec.tabs.some((t) => t.id === deps.tab) ? (deps.tab ?? '') : (spec.tabs[0]?.id ?? '')

    return {
      spec,
      tab,
      boards: fetchCategoryBoards({ data: { category, tab } }),
      tiles: fetchCategoryTiles({ data: { category, tab } }),
    }
  },
  component: CategoryPage,
})

function CategoryPage() {
  const { spec, tab, boards, tiles } = Route.useLoaderData()
  const { category } = Route.useParams()

  return (
    <>
      <header className="page-head">
        <h1>{spec.label}</h1>
      </header>
      <p className="lede cat-lede">{spec.lede}</p>

      {spec.tabs.length > 0 && (
        <nav className="tabs">
          {spec.tabs.map((t) => (
            <Link
              key={t.id}
              to="/c/$category"
              params={{ category }}
              search={{ tab: t.id }}
              className={t.id === tab ? 'active' : ''}
              replace
            >
              {t.label}
            </Link>
          ))}
        </nav>
      )}

      <Await promise={boards} fallback={<BoardsPlaceholder spec={spec} />}>
        {(payload) => <CategoryBoards payload={payload} />}
      </Await>

      {/* A category whose boards cover everything has no tile directory, and
          a placeholder for a section that never arrives is worse than none. */}
      {spec.tileGroups === 0 ?
        <Await promise={tiles}>{(t) => <CategoryTilesView tiles={t} />}</Await>
      : <Await promise={tiles} fallback={<TilesSkeleton groups={spec.tileGroups} />}>
          {(t) => <CategoryTilesView tiles={t} />}
        </Await>
      }
    </>
  )
}

/** The headline band plus the grid, sized to the page that is arriving. */
function BoardsPlaceholder({ spec }: { spec: CategorySpec }) {
  return (
    <>
      <StatBandSkeleton />
      <BoardsSkeleton spans={spec.boardSpans} />
    </>
  )
}

function CategoryBoards({ payload }: { payload: CategoryPayload }) {
  switch (payload.kind) {
    case 'ai':
      return <AiView data={payload.data} />
    case 'tv':
      return <TvView data={payload.data} />
    case 'books':
      return <BooksView data={payload.data} />
    case 'home':
      return <HomeView data={payload.data} />
    case 'network':
      return <NetworkView data={payload.data} />
    case 'system':
      return <SystemView data={payload.data} />
    case 'monitoring':
      return <MonitoringView data={payload.data} />
    case 'gaming':
      return <GamingView data={payload.data} />
  }
}

function CategoryTilesView({ tiles }: { tiles: CategoryTiles }) {
  return (
    <>
      {/* Named, not counted. "2 services down" makes you go hunting; the names
          are the entire content of that sentence. */}
      {tiles.down.length > 0 && (
        <p className="panel-note tile-alarm">Not answering: {tiles.down.join(', ')}</p>
      )}

      {tiles.groups.map((g) => (
        <section key={g.name} className="tile-group">
          <h2 className="tile-group-head">
            <span aria-hidden="true">{g.icon}</span>
            {g.name}
          </h2>
          <div className="tile-grid">
            {g.tiles.map((t) => (
              <TileCard key={t.key} tile={t} />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

function TileCard({ tile }: { tile: Tile }) {
  // `up === null` means "nothing probes this" — the off-box services and the
  // link-only bookmarks. Rendering that as a grey dot rather than a red one is
  // the difference between "no opinion" and "down", and only one is true.
  const state = tile.up === null ? 'unknown' : tile.up ? 'up' : 'down'

  return (
    <article className={`tile tile-${state}`}>
      <header>
        <span
          className={`dot dot-${tile.up === null ? 'unknown' : tile.up ? 'running' : 'stopped'}`}
        />
        <a href={tile.href} target="_blank" rel="noreferrer">
          {tile.name}
        </a>
      </header>
      <p className="tile-desc">{tile.description}</p>

      {tile.stats.length > 0 && (
        <dl className="tile-stats">
          {tile.stats.map((s) => (
            <div key={s.label}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {tile.note !== null && <p className="tile-note">{tile.note}</p>}
    </article>
  )
}
