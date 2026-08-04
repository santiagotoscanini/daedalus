import { createFileRoute, Link } from '@tanstack/react-router'
import { fetchDashboard, type DashboardTile } from '../server/dashboard'

// The fleet at a glance — everything on the box that is not an app.
//
// Apps are deliberately not here: /apps already shows them with drift, deploy
// history, resource caps and logs, and a second, thinner view of the same
// services would be one more thing to keep in sync.

const TABS = ['home', 'infra'] as const
type Tab = (typeof TABS)[number]

export const Route = createFileRoute('/dashboard')({
  // Same reasoning as the app detail page: the tab is in the URL so it
  // survives a refresh, can be linked, and renders on the server.
  validateSearch: (search: Record<string, unknown>): { tab: Tab } => ({
    tab: TABS.includes(search.tab as Tab) ? (search.tab as Tab) : 'home',
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  // Only the open tab is fetched — each one is ~15 upstream calls, and paying
  // for both to show half of it is the kind of quiet waste that turns a
  // dashboard into something you stop opening.
  loader: ({ deps }) => fetchDashboard({ data: { tab: deps.tab } }),
  component: Dashboard,
})

function Dashboard() {
  const { groups } = Route.useLoaderData()
  const { tab } = Route.useSearch()

  const all = groups.flatMap((g) => g.tiles)
  const down = all.filter((t) => t.up === false)

  return (
    <>
      <header className="page-head">
        <h1>Dashboard</h1>
        <span className="count-badge">{all.length} services</span>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <Link
            key={t}
            to="/dashboard"
            search={{ tab: t }}
            className={t === tab ? 'active' : ''}
            replace
          >
            {t}
          </Link>
        ))}
      </nav>

      {/* Named, not counted. "2 services down" makes you go hunting; the
          names are the entire content of that sentence. */}
      {down.length > 0 && (
        <p className="panel-note tile-alarm">
          Not answering: {down.map((t) => t.name).join(', ')}
        </p>
      )}

      {groups.map((g) => (
        <section key={g.name} className="tile-group">
          <h2 className="tile-group-head">
            <span aria-hidden="true">{g.icon}</span>
            {g.name}
          </h2>
          <div className="tile-grid">
            {g.tiles.map((t) => (
              <Tile key={t.key} tile={t} />
            ))}
          </div>
        </section>
      ))}
    </>
  )
}

function Tile({ tile }: { tile: DashboardTile }) {
  // `up === null` means "nothing probes this" — the off-box services and the
  // link-only bookmarks. Rendering that as a grey dot rather than a red one is
  // the difference between "no opinion" and "down", and only one of those is
  // true.
  const state = tile.up === null ? 'unknown' : tile.up ? 'up' : 'down'

  return (
    <article className={`tile tile-${state}`}>
      <header>
        <span className={`dot dot-${tile.up === null ? 'unknown' : tile.up ? 'running' : 'stopped'}`} />
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
