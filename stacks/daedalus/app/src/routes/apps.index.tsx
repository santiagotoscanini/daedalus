import { createFileRoute, Link } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useMemo, useState } from 'react'
import { Sparkline, StateDot, type AppState } from '../components/status'

// The app list. Every row joins three sources:
//   the registry (Postgres — what daedalus believes),
//   the Nix manifest (what the box was actually built from → drift),
//   Prometheus (what is happening right now).

const getApps = createServerFn().handler(async () => {
  const { listApps, driftOf } = await import('../lib/repo/apps')
  const { manifestEntries } = await import('../lib/nix-manifest')
  const { appStatuses } = await import('../lib/metrics')

  const records = await listApps()
  const manifest = new Map((await manifestEntries()).map((m) => [m.name, m]))
  // No .catch here: appStatuses runs its queries under allSettled and degrades
  // to "unknown" per app rather than rejecting, so a prometheus outage costs
  // the status column, not the page.
  const statuses = await appStatuses(records.map((r) => r.name))

  return records.map((r) => ({
    name: r.name,
    stage: r.stage,
    managedInNix: r.managedInNix,
    sourceMode: r.sourceMode,
    description: r.homepageDescription,
    hostname: `${r.name}.toscanini.me`,
    authMode: r.authMode,
    postgres: r.postgres,
    drift: driftOf(r, manifest.get(r.name)),
    status: statuses[r.name] ?? {
      state: 'unknown' as const,
      containerUp: null,
      healthy: null,
      rpm: null,
      spark: [],
    },
  }))
})

export const Route = createFileRoute('/apps/')({
  loader: () => getApps(),
  component: AppsList,
})

type Row = Awaited<ReturnType<typeof getApps>>[number]

function AppsList() {
  const rows = Route.useLoaderData()
  const [search, setSearch] = useState('')
  const [state, setState] = useState<'all' | AppState>('all')
  const [exposure, setExposure] = useState<'all' | 'live' | 'lab'>('all')

  const counts = useMemo(
    () => ({
      running: rows.filter((r) => r.status.state === 'running').length,
      attention: rows.filter((r) => r.status.state === 'attention').length,
      stopped: rows.filter((r) => r.status.state === 'stopped' || r.status.state === 'unknown')
        .length,
    }),
    [rows],
  )

  const visible = rows.filter(
    (r) =>
      (state === 'all' || r.status.state === state) &&
      (exposure === 'all' || r.stage === exposure) &&
      (search === '' || `${r.name} ${r.description}`.toLowerCase().includes(search.toLowerCase())),
  )

  const drifted = rows.filter((r) => r.drift.length > 0)

  return (
    <>
      <header className="page-head">
        <h1>Apps</h1>
        <span className="count-badge">{rows.length}</span>
      </header>

      {drifted.length > 0 && (
        <div className="banner">
          <strong>{drifted.length} app(s) changed but not applied.</strong> The registry no longer
          matches what Nix built ({drifted.map((d) => d.name).join(', ')}). Applying is not wired up
          yet — for now the difference is informational.
        </div>
      )}

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
            ['all', 'all'],
            ['running', 'running'],
            ['attention', 'issues'],
            ['stopped', 'stopped'],
          ]}
        />
        <Segmented
          value={exposure}
          onChange={setExposure}
          options={[
            ['all', 'all'],
            ['live', 'external'],
            ['lab', 'internal'],
          ]}
        />
      </div>

      <ul className="app-list">
        {visible.map((r) => (
          <AppRow key={r.name} row={r} />
        ))}
        {visible.length === 0 && <li className="empty">No apps match that filter.</li>}
      </ul>
    </>
  )
}

function AppRow({ row }: { row: Row }) {
  return (
    <li>
      <Link to="/apps/$name" params={{ name: row.name }} className="app-row">
        <StateDot state={row.status.state} />

        <div className="app-id">
          <div className="app-name">
            {row.name}
            {row.managedInNix && (
              <span className="chip chip-muted" title="Declared by hand in Nix — read-only here">
                nix
              </span>
            )}
            {row.drift.length > 0 && (
              <span className="chip chip-warn" title={`Changed: ${row.drift.join(', ')}`}>
                unapplied
              </span>
            )}
          </div>
          <div className="app-sub">{row.description || '—'}</div>
        </div>

        <code className="app-host">{row.hostname}</code>

        <span className={row.stage === 'live' ? 'chip chip-live' : 'chip chip-lab'}>
          {row.stage === 'live' ? 'external' : 'internal'}
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

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: [T, string][]
}) {
  return (
    <div className="segmented">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          className={v === value ? 'active' : ''}
          onClick={() => {
            onChange(v)
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
