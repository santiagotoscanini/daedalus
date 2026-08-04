import { createFileRoute, Link, notFound } from '@tanstack/react-router'

import { AiView } from '../components/category/ai'
import { HomeView } from '../components/category/home'
import { BooksView, TvView } from '../components/category/media'
import { NetworkView } from '../components/category/network'
import { SystemView } from '../components/category/system'
import { CATEGORIES } from '../lib/dashboard/nav'
import { fetchCategory, type Tile } from '../server/category'
import type { CategoryName } from '../lib/dashboard/tiles'

// One page per category, replacing the single Dashboard tab.
//
// The split is by *subject*, not by service: someone opening Media wants to
// know what is playing and what is downloading, and does not care that those
// two facts come from six containers. So each page leads with panels built
// around the question, and keeps the per-service cards underneath as a
// directory — the cards are where you go to click through to the thing.

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
    return fetchCategory({
      data: { category: params.category as CategoryName, tab: deps.tab ?? '' },
    })
  },
  component: CategoryPage,
})

function CategoryPage() {
  const payload = Route.useLoaderData()
  const { category } = Route.useParams()
  const { meta } = payload

  return (
    <>
      <header className="page-head">
        <h1>{meta.title}</h1>
      </header>
      <p className="lede cat-lede">{meta.lede}</p>

      {meta.tabs.length > 0 && (
        <nav className="tabs">
          {meta.tabs.map((t) => (
            <Link
              key={t.id}
              to="/c/$category"
              params={{ category }}
              search={{ tab: t.id }}
              className={t.id === meta.tab ? 'active' : ''}
              replace
            >
              {t.label}
            </Link>
          ))}
        </nav>
      )}

      {/* Named, not counted. "2 services down" makes you go hunting; the names
          are the entire content of that sentence. */}
      {meta.down.length > 0 && (
        <p className="panel-note tile-alarm">Not answering: {meta.down.join(', ')}</p>
      )}

      {payload.kind === 'ai' && <AiView data={payload.data} />}
      {payload.kind === 'tv' && <TvView data={payload.data} />}
      {payload.kind === 'books' && <BooksView data={payload.data} />}
      {payload.kind === 'home' && <HomeView data={payload.data} />}
      {payload.kind === 'network' && <NetworkView data={payload.data} />}
      {payload.kind === 'system' && <SystemView data={payload.data} />}

      {meta.groups.map((g) => (
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
