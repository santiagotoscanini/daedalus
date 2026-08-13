import { createFileRoute, Link } from '@tanstack/react-router'
import { type ReactNode, useMemo, useState } from 'react'
import { ApplyBar } from '../components/apply-bar'
import { GuardedAwait } from '../components/error'
import { ImagesView, PackagesView } from '../components/registries'
import { BoardsSkeleton, RowsSkeleton } from '../components/skeleton'
import { TabBar } from '../components/tabs'
import { AppIcon, type AppState, Segmented, StateDot } from '../components/ui'
import { Spark } from '../components/viz'
import { PLATFORMS, type Platform } from '../lib/external-apps'
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
type ExternalEntry = ListData['external'][number]

function AppsPage() {
  const { tab, list, images, packages } = Route.useLoaderData()

  return (
    <>
      <header className="page-head">
        <h1>Apps</h1>
      </header>
      <p className="lede cat-lede">
        What this box runs of its own, what lives on someone else's infrastructure, and the two
        registries everything here is built out of.
      </p>

      <TabBar tabs={TABS} active={tab} linkTo={(id) => ({ to: '/apps', search: { tab: id } })} />

      {list !== null && (
        <GuardedAwait resetKey={tab} promise={list} fallback={<RowsSkeleton count={4} />}>
          {(data) => <AppsList data={data} />}
        </GuardedAwait>
      )}

      {images !== null && (
        <GuardedAwait
          resetKey={tab}
          promise={images}
          fallback={<BoardsSkeleton spans={[8, 4, 8, 4]} />}
        >
          {(data) => <ImagesView d={data} />}
        </GuardedAwait>
      )}

      {packages !== null && (
        <GuardedAwait
          resetKey={tab}
          promise={packages}
          fallback={<BoardsSkeleton spans={[6, 6, 12]} />}
        >
          {(data) => <PackagesView d={data} />}
        </GuardedAwait>
      )}
    </>
  )
}

export function AppsList({ data }: { data: ListData }) {
  const { apps, applyStatus, external } = data
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

  // The off-box projects answer the search box but not the state/exposure
  // filters — nothing here probes them, so they have no state to match, and
  // pretending "external hosting" is an exposure would put them under a
  // filter that means "published through the tunnel". They simply step aside
  // while either filter is narrowing.
  const offBox =
    state === 'all' && exposure === 'all'
      ? external.filter(
          (e) =>
            search === '' ||
            `${e.name} ${e.host} ${e.description}`.toLowerCase().includes(search.toLowerCase()),
        )
      : []

  // The control plane's own row carries whether it serves an icon, so the
  // section head borrows it rather than probing again.
  const selfHasIcon = apps.find((a) => a.name === 'daedalus')?.hasIcon ?? false

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
          label="Filter by state"
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
          label="Filter by exposure"
          options={[
            { value: 'all', label: 'all' },
            { value: 'live', label: 'external' },
            { value: 'lab', label: 'internal' },
            { value: 'off', label: 'off' },
          ]}
        />
      </div>

      <SectionHead
        icon={<AppIcon name="daedalus" hasIcon={selfHasIcon} size={15} />}
        title="Daedalus"
        sub="deployed, watched and managed on this box"
      />
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

      {/* Projects hosted off the box, one section per platform. The registry
          knows nothing about them — the list is a hand-edited literal
          (lib/external-apps.ts) — so the rows link out to the site itself
          rather than to a detail page there is no data to fill. */}
      {PLATFORMS.map((p) => {
        const entries = offBox.filter((e) => e.platform === p.id)
        if (entries.length === 0) return null
        return (
          <div key={p.id}>
            <SectionHead icon={PLATFORM_ICONS[p.id]} title={p.id} sub={p.description} />
            <ul className="app-list app-list-platform">
              {entries.map((e) => (
                <ExternalRow key={e.id} entry={e} />
              ))}
            </ul>
          </div>
        )
      })}

      <ApplyBar changed={changed} initialStatus={applyStatus} />
    </>
  )
}

function SectionHead({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <h2 className="section-head">
      <span className="section-glyph" aria-hidden="true">
        {icon}
      </span>
      {title}
      <small>{sub}</small>
    </h2>
  )
}

// The two brand marks, inlined. NOT in glyph.tsx, on that file's own rule:
// its set is stroke pictographs named by shape, and these are filled logos
// that are nothing without their subject. `currentColor` keeps them on the
// section head's own grey in both themes.
const PLATFORM_ICONS: Record<Platform, ReactNode> = {
  'GitHub Pages': (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" role="presentation">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  ),
  Vercel: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" role="presentation">
      <path d="M12 2.5 23 21.5H1L12 2.5Z" />
    </svg>
  ),
}

function ExternalRow({ entry }: { entry: ExternalEntry }) {
  return (
    <li>
      <a
        href={`https://${entry.host}`}
        target="_blank"
        rel="noreferrer"
        className="app-row app-row-external"
      >
        <AppIcon name={entry.id} hasIcon={entry.hasIcon} />

        <div className="app-id">
          <div className="app-name">{entry.name}</div>
          <div className="app-sub">{entry.description}</div>
        </div>

        <code className="app-host">{entry.host}</code>
      </a>
    </li>
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
            row.stage === 'live'
              ? 'chip chip-live'
              : row.stage === 'off'
                ? 'chip chip-off'
                : 'chip chip-lab'
          }
        >
          {row.stage === 'live' ? 'external' : row.stage === 'off' ? 'not exposed' : 'internal'}
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
