import { createFileRoute, Link } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { ApplyBar } from '../components/apply-bar'
import { Segmented, Sparkline, StateDot, type AppState } from '../components/ui'
import { fetchApps } from '../server/registry'

// The app list. Every row joins three sources: the registry (Postgres — what
// daedalus believes), the Nix manifest (what the box was actually built from,
// hence drift), and Prometheus (what is happening right now).

export const Route = createFileRoute('/apps/')({
  loader: () => fetchApps(),
  component: AppsList,
})

type Row = Awaited<ReturnType<typeof fetchApps>>['apps'][number]

export function AppsList() {
  const { apps, applyStatus } = Route.useLoaderData()
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
