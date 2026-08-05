import { Await, createFileRoute, Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { ApplyBar } from '../components/apply-bar'
import { BoardsSkeleton, RowsSkeleton } from '../components/skeleton'
import { Segmented, Sparkline, StateDot, type AppState } from '../components/ui'
import { BarList, Board, BoardGrid, Chip, Facts, Pulse } from '../components/viz'
import { fetchApps, fetchRegistries } from '../server/registry'

// The app list. Every row joins three sources: the registry (Postgres — what
// daedalus believes), the Nix manifest (what the box was actually built from,
// hence drift), and Prometheus (what is happening right now).
//
// Two loads, neither awaited: the rows come out of Postgres in milliseconds,
// the registries are two upstreams through traefik. Holding the list for them
// would mean the fast half of the page waits on the slow half for no reason.

export const Route = createFileRoute('/apps/')({
  loader: () => ({ list: fetchApps(), registries: fetchRegistries() }),
  component: AppsPage,
})

type ListData = Awaited<ReturnType<typeof fetchApps>>
type Row = ListData['apps'][number]

function AppsPage() {
  const { list, registries } = Route.useLoaderData()

  return (
    <>
      <Await promise={list} fallback={<ListSkeleton />}>
        {(data) => <AppsList data={data} />}
      </Await>

      <h2 className="section-head">
        Shared registries
        <small>every app above is built out of these</small>
      </h2>
      <Await promise={registries} fallback={<BoardsSkeleton spans={[6, 6]} />}>
        {(data) => <Registries data={data} />}
      </Await>
    </>
  )
}

/** The header and filters are part of the shape, so they are in the skeleton. */
function ListSkeleton() {
  return (
    <>
      <header className="page-head">
        <h1>Apps</h1>
      </header>
      <RowsSkeleton count={3} />
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
      <header className="page-head">
        <h1>Apps</h1>
        {/* Counts what daedalus manages, not what it renders — the control
            plane below is not one of them. */}
        <span className="count-badge">{apps.filter((a) => !a.managedInNix).length}</span>
        {/* The create flow is a page rather than a dialog: it makes a GitHub
            round trip per repo it checks, and a checklist you can leave open
            in a tab while you go fix a workflow is worth more than one that
            closes when you click outside it. */}
        <Link to="/apps/new" className="btn btn-primary page-head-action">
          Add an app
        </Link>
      </header>

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

/**
 * The two registries every app above is assembled from.
 *
 * Here rather than on a category page because they are not a subject — they
 * are shared plumbing for exactly the things listed above this section, and
 * when a deploy stops moving one of them is usually the reason.
 */
function Registries({ data }: { data: Awaited<ReturnType<typeof fetchRegistries>> }) {
  const { images, packages } = data

  return (
    <>
      <BoardGrid>
        <Board
          title="Container images"
          icon="◲"
          span={6}
          aside={
            images.reachable ?
              <Chip tone="ok">zot {images.version ?? ''}</Chip>
            : <Chip tone="bad">unreachable</Chip>
          }
        >
          <div className="reg-repos">
            {images.repositories.map((r) => (
              <span key={r} className="reg-repo">
                <Pulse on={false} tone="ok" />
                {r}
              </span>
            ))}
            {images.repositories.length === 0 && (
              <p className="viz-empty">
                {images.reachable ? 'no repositories published yet' : 'could not read the catalogue'}
              </p>
            )}
          </div>
          <Facts
            rows={[
              { k: 'App repositories', v: String(images.repositories.length) },
              // The cache/* repos are the upstream base images the builds pull
              // through zot, not anything built here.
              { k: 'Upstream cached', v: String(images.cached) },
              { k: 'On disk', v: images.storageBytes === null ? '—' : fmtBytes(images.storageBytes) },
              { k: 'Pushes', v: images.pushes === null ? '—' : images.pushes.toLocaleString('en-US') },
              {
                k: 'Requests',
                v:
                  images.requestsPerHour === null ?
                    '—'
                  : `${images.requestsPerHour.toFixed(0)}/hour`,
              },
            ]}
          />
          <h4 className="board-sub">Storage by repository</h4>
          <BarList items={images.byRepo} tone="info" empty="nothing stored" />
          <h4 className="board-sub">Pulls since zot last started</h4>
          <BarList items={images.pulls} empty="no pulls recorded" />
          {/* The deploy timer pulls by tag every two minutes and only restarts
              when the digest actually moved — so these counters climb steadily
              on a box where nothing is being deployed. */}
          <p className="board-foot">
            Each app’s deploy timer pulls every 2 minutes and restarts only when the digest moved,
            so the pull count climbs even when nothing ships.
          </p>
        </Board>

        <Board
          title="npm packages"
          icon="◳"
          span={6}
          aside={
            packages.reachable ?
              <Chip tone="ok">verdaccio</Chip>
            : <Chip tone="bad">unreachable</Chip>
          }
        >
          <Facts
            rows={[
              { k: 'Published here', v: packages.published === null ? '—' : String(packages.published) },
              { k: 'Cached from npmjs', v: fmtNum(packages.cached) },
              { k: 'Versions held', v: fmtNum(packages.versions) },
              // Resolving a dependency tree caches a MANIFEST even when no
              // tarball is ever fetched, so "cached" runs ahead of what is
              // genuinely on disk. This is the stricter reading.
              { k: 'With a tarball', v: fmtNum(packages.withTarball) },
              { k: 'Holding several versions', v: fmtNum(packages.multiVersion) },
            ]}
          />
          <p className="board-foot">
            LAN-only, and a pull-through cache first: a package counts as cached the moment its
            manifest is resolved, which is why that number leads the tarball count. Publishing here
            is opt-in — nothing does it yet.
          </p>
        </Board>
      </BoardGrid>
    </>
  )
}

function fmtNum(v: number | null): string {
  return v === null ? '—' : v.toLocaleString('en-US')
}

function fmtBytes(v: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = v
  let u = 0
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024
    u++
  }
  return `${n.toFixed(n >= 10 || u === 0 ? 0 : 1)} ${units[u] ?? 'B'}`
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
          <Sparkline values={row.status.spark} state={row.status.state} />
          <span className="rpm">
            {row.status.rpm === null ? '—' : `${row.status.rpm.toFixed(1)} rpm`}
          </span>
        </div>
      </Link>
    </li>
  )
}
