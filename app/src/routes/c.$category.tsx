import { Await, createFileRoute, Link, notFound } from '@tanstack/react-router'

import { AiView } from '../components/category/ai'
import { HomeView } from '../components/category/home'
import { BooksView, TvView } from '../components/category/media'
import { GamingView } from '../components/category/gaming'
import { MonitoringView } from '../components/category/monitoring'
import { NetworkView } from '../components/category/network'
import { SecurityView } from '../components/category/security'
import { SystemView } from '../components/category/system'
import { BoardsSkeleton, StatBandSkeleton, TilesSkeleton } from '../components/skeleton'
import { CATEGORIES, type CategorySpec } from '../lib/dashboard/nav'
import {
  fetchCategoryBoards,
  fetchCategoryTiles,
  fetchTabStatus,
  type CategoryPayload,
  type CategoryTiles,
  type TabStatus,
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
      // Only where a tab actually wears a dot — see CategorySpec.tabs.
      tabStatus:
        spec.tabs.some((t) => t.probe !== undefined) ?
          fetchTabStatus({ data: { category } })
        : null,
    }
  },
  component: CategoryPage,
})

function CategoryPage() {
  const { spec, tab, boards, tiles, tabStatus } = Route.useLoaderData()
  const { category } = Route.useParams()
  const groups = spec.tabs.find((t) => t.id === tab)?.tileGroups ?? spec.tileGroups

  return (
    <>
      <header className="page-head">
        <h1>{spec.label}</h1>
      </header>
      <p className="lede cat-lede">{spec.lede}</p>

      {spec.tabs.length > 0 &&
        (tabStatus === null ?
          <TabNav spec={spec} category={category} tab={tab} status={null} />
        : // The tabs are drawn immediately either way — navigation is the one
          // thing on this page that must never wait. The dot arrives in its
          // reserved slot, grey until it is known, so nothing moves.
          <Await
            promise={tabStatus}
            fallback={<TabNav spec={spec} category={category} tab={tab} status={null} />}
          >
            {(status) => <TabNav spec={spec} category={category} tab={tab} status={status} />}
          </Await>)}

      <Await promise={boards} fallback={<BoardsPlaceholder spec={spec} tab={tab} />}>
        {(payload) => <CategoryBoards payload={payload} />}
      </Await>

      {/* A category whose boards cover everything has no tile directory, and
          a placeholder for a section that never arrives is worse than none.
          Per TAB, not per category: a directory can belong to one sibling and
          not the others — Network's does. */}
      {groups === 0 ?
        <Await promise={tiles}>{(t) => <CategoryTilesView tiles={t} />}</Await>
      : <Await promise={tiles} fallback={<TilesSkeleton groups={groups} />}>
          {(t) => <CategoryTilesView tiles={t} />}
        </Await>
      }
    </>
  )
}

/**
 * The sub-tab row, optionally wearing each tab's status.
 *
 * `status === null` covers both "this category has no probes" and "they have
 * not landed yet". The dot is drawn in the second case and not the first,
 * which is why the caller decides rather than this component: a grey dot is a
 * claim ("nothing is probing this"), and a category that never had one should
 * not appear to be making it.
 */
function TabNav({
  spec,
  category,
  tab,
  status,
}: {
  spec: CategorySpec
  category: string
  tab: string
  status: TabStatus | null
}) {
  const dotted = spec.tabs.some((t) => t.probe !== undefined)

  return (
    <nav className="tabs">
      {spec.tabs.map((t) => {
        const up = status?.[t.id] ?? null
        return (
          <Link
            key={t.id}
            to="/c/$category"
            params={{ category }}
            search={{ tab: t.id }}
            className={t.id === tab ? 'active' : ''}
            replace
          >
            {dotted && (
              <span
                className={`dot dot-${up === null ? 'unknown' : up ? 'running' : 'attention'}`}
                role="img"
                aria-label={up === null ? 'status unknown' : up ? 'up' : 'not answering'}
                title={
                  t.probe === undefined ? 'nothing probes this yet'
                  : up === null ? 'no reading from gatus'
                  : up ? 'answering'
                  : 'not answering'
                }
              />
            )}
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * The headline band plus the grid, sized to the page that is arriving.
 *
 * Sized per TAB where a tab says so: the category's own spans describe its
 * default tab, and a sibling laid out differently would reflow on arrival —
 * worst of all a band of stat cards that the page turns out not to have.
 */
function BoardsPlaceholder({ spec, tab }: { spec: CategorySpec; tab: string }) {
  const t = spec.tabs.find((x) => x.id === tab)

  return (
    <>
      {t?.statBand !== false && <StatBandSkeleton />}
      <BoardsSkeleton spans={t?.boardSpans ?? spec.boardSpans} />
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
    case 'security':
      return <SecurityView data={payload.data} />
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
