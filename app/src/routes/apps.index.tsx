import { Await, createFileRoute, Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { ApplyBar } from '../components/apply-bar'
import { BoardsSkeleton, RowsSkeleton } from '../components/skeleton'
import { ImagesView, PackagesView } from '../components/registries'
import { AppIcon, Segmented, StateDot, type AppState } from '../components/ui'
import { Spark } from '../components/viz'
import { fetchApps, fetchImagesTab, fetchPackagesTab } from '../server/registry'

// The app list. Every row joins three sources: the registry (Postgres — what
// daedalus believes), the Nix manifest (what the box was actually built from,
// hence drift), and Prometheus (what is happening right now).

// Three tabs, the same shape every category page uses: what this box runs, and
// the two registries it is built out of.
//
// The registries were boards at the foot of the app list. They are services —
// containers with release cycles, logs and neighbours — and as a footer they
// got a handful of numbers and no room for any of that. A tab each gives them
// the header, version verdict, changelog and log every other service here has,
// and it takes the app list back to being one thing.
const TABS = [
  { id: 'apps', label: 'Apps' },
  { id: 'images', label: 'Container registry' },
  { id: 'packages', label: 'npm packages' },
] as const

type Tab = (typeof TABS)[number]['id']

export const Route = createFileRoute('/apps/')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => ({
    tab: TABS.some((t) => t.id === search.tab) ? (search.tab as Tab) : undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab ?? ('apps' as const) }),
  // Only the open tab's data is fetched. The registries are two upstreams
  // through traefik plus a GitHub release lookup each, and the app list is a
  // Postgres read — pairing them cost the fast one every time.
  loader: ({ deps }) => ({
    tab: deps.tab,
    list: deps.tab === 'apps' ? fetchApps() : null,
    images: deps.tab === 'images' ? fetchImagesTab() : null,
    packages: deps.tab === 'packages' ? fetchPackagesTab() : null,
  }),
  component: AppsPage,
})

type ListData = Awaited<ReturnType<typeof fetchApps>>
type Row = ListData['apps'][number]

function AppsPage() {
  const { tab, list, images, packages } = Route.useLoaderData()

  return (
    <>
      <header className="page-head">
        <h1>Apps</h1>
      </header>
      <p className="lede cat-lede">
        What this box runs of its own, and the two registries every one of them is built out of.
      </p>

      <nav className="tabs">
        {TABS.map((t) => (
          <Link
            key={t.id}
            to="/apps"
            search={{ tab: t.id }}
            className={t.id === tab ? 'active' : ''}
            replace
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {list !== null && (
        <Await promise={list} fallback={<RowsSkeleton count={4} />}>
          {(data) => <AppsList data={data} />}
        </Await>
      )}

      {images !== null && (
        <Await promise={images} fallback={<BoardsSkeleton spans={[8, 4, 8, 4]} />}>
          {(data) => <ImagesView d={data} />}
        </Await>
      )}

      {packages !== null && (
        <Await promise={packages} fallback={<BoardsSkeleton spans={[6, 6, 12]} />}>
          {(data) => <PackagesView d={data} />}
        </Await>
      )}
    </>
  )
}

export function AppsList({ data }: { data: ListData }) {
  const { apps, applyStatus } = data
  const [search, setSearch] = useState('')
  const [state, setState] = useState<'all' | AppState>('all')
  const [exposure, setExposure] = useState<'all' | 'live' | 'lab' | 'off'>('all')

  const counts = useMemo(
    () => ({
      running: apps.filter((r) => r.status.state === 'running').length,
      attention: apps.filter((r) => r.status.state === 'attention').length,
      stopped: apps.filter((r) => r.status.state === 'stopped' || r.status.state === 'unknown')
        .length,
    }),
    [apps],
  )

  const visible = apps.filter(
    (r) =>
      (state === 'all' || r.status.state === state) &&
      (exposure === 'all' || r.stage === exposure) &&
      (search === '' || `${r.name} ${r.description}`.toLowerCase().includes(search.toLowerCase())),
  )

  // Nix-managed entries (the control plane itself) render in their own
  // section, so the list above is exactly "the apps daedalus manages".
  const managed = visible.filter((r) => !r.managedInNix)
  const platform = visible.filter((r) => r.managedInNix)

  const changed = apps
    .filter((a) => !a.managedInNix && a.drift.length > 0)
    .map((a) => ({ name: a.name, fields: a.drift }))

  return (
    <>
      <div className="tallies">
        <span>
          <StateDot state="running" /> <b>{counts.running}</b> running
        </span>
        <span>
          <StateDot state="attention" /> <b>{counts.attention}</b> need attention
        </span>
        <span>
          <StateDot state="stopped" /> <b>{counts.stopped}</b> stopped
        </span>
        {/* The create flow is a page rather than a dialog: it makes a GitHub
            round trip per repo it checks, and a checklist you can leave open
            in a tab while you go fix a workflow is worth more than one that
            closes when you click outside it. */}
        <Link to="/apps/new" className="btn btn-primary tallies-action">
          Add an app
        </Link>
      </div>

      <div className="filters">
        <input
          className="search"
          type="search"
          placeholder="Search apps…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
          }}
        />
        <Segmented
          value={state}
          onChange={setState}
          options={[
            { value: 'all', label: 'all' },
            { value: 'running', label: 'running' },
            { value: 'attention', label: 'issues' },
            { value: 'stopped', label: 'stopped' },
          ]}
        />
        <Segmented
          value={exposure}
          onChange={setExposure}
          options={[
            { value: 'all', label: 'all' },
            { value: 'live', label: 'external' },
            { value: 'lab', label: 'internal' },
            { value: 'off', label: 'off' },
          ]}
        />
      </div>

      <ul className="app-list">
        {managed.map((r) => (
          <AppRow key={r.name} row={r} />
        ))}
        {managed.length === 0 && <li className="empty">No apps match that filter.</li>}
      </ul>

      {/* The control plane sits below its own rule rather than in the list.
          It is not one of the things being managed — it is the thing doing the
          managing, it is declared by hand in Nix, and every control on it is
          read-only. Mixing it in invites you to try editing it. */}
      {platform.length > 0 && (
        <>
          <h2 className="section-head">
            Control plane
            <small>declared in Nix, not editable here</small>
          </h2>
          <ul className="app-list app-list-platform">
            {platform.map((r) => (
              <AppRow key={r.name} row={r} />
            ))}
          </ul>
        </>
      )}

      <ApplyBar changed={changed} initialStatus={applyStatus} />
    </>
  )
}


function AppRow({ row }: { row: Row }) {
  return (
    <li>
      {/* `tab` is a required search param on the detail route (it is what
          makes the tab linkable and server-rendered), so the list has to name
          the landing tab explicitly. */}
      <Link
        to="/apps/$name"
        params={{ name: row.name }}
        search={{ tab: 'overview' as const }}
        className="app-row"
      >
        <StateDot state={row.status.state} />
        <AppIcon name={row.name} hasIcon={row.hasIcon} />

        <div className="app-id">
          <div className="app-name">
            {row.name}
            {row.managedInNix && (
              <span className="chip chip-muted" title="Declared by hand in Nix — read-only here">
                nix
              </span>
            )}
            {!row.managedInNix && row.drift.length > 0 && (
              <span className="chip chip-warn" title={`Changed: ${row.drift.join(', ')}`}>
                unapplied
              </span>
            )}
          </div>
          <div className="app-sub">{row.description || '—'}</div>
        </div>

        <code className="app-host">{row.hostname}</code>

        <span
          className={
            row.stage === 'live' ? 'chip chip-live'
            : row.stage === 'off' ? 'chip chip-off'
            : 'chip chip-lab'
          }
        >
          {row.stage === 'live' ? 'external'
          : row.stage === 'off' ? 'not exposed'
          : 'internal'}
        </span>

        <div className="app-spark">
          {/* Neutral unless the app is in trouble: the dot at the head of the
              row already carries state, and a green line on every healthy app
              would make the one red line harder to find, not easier. */}
          <Spark
            values={row.status.spark}
            tone={row.status.state === 'attention' ? 'bad' : 'muted'}
            width={88}
            height={20}
          />
          <span className="rpm">
            {row.status.rpm === null ? '—' : `${row.status.rpm.toFixed(1)} rpm`}
          </span>
        </div>
      </Link>
    </li>
  )
}
