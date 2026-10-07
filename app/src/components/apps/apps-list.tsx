// The apps list: a toolbar whose filters are the tallies, a table of the apps
// this box runs, the control plane, and the projects off the box.

import { Link } from '@tanstack/react-router'
import { SearchIcon } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { cn } from '../../lib/cn'
import { PLATFORMS } from '../../lib/external-apps'
import { APP_STAGES, type AppStage, STAGE_LABEL } from '../../lib/stage'
import type { fetchAppsTab } from '../../routes/apps.index'
import { ApplyBar } from '../apply-bar'
import { type AppState, StateDot } from '../controls'
import { SECTION_NOTE, SECTION_TITLE } from '../table'
import { Input } from '../ui/input'
import { Picker } from '../ui/picker'
import {
  APP_TABLE,
  AppRow,
  AppTableHead,
  ExternalRow,
  GroupRow,
  PLATFORM_ICONS,
  SiteTableHead,
} from './app-card'
import { SegmentPicker } from './shared'

type ListData = Awaited<ReturnType<typeof fetchAppsTab>>
export type Row = ListData['apps'][number]
export type ExternalEntry = ListData['external'][number]

/** Exported for `RowsSkeleton`, so the placeholder reserves the real frame. */
export const APP_LIST = APP_TABLE

/** Search, the two filters and the one action: one row, one height. */
const TOOLBAR = 'mb-3 flex flex-wrap items-center gap-2'

export function AppsList({ data }: { data: ListData }) {
  const { apps, applyStatus, external, offboxStatus } = data
  const [search, setSearch] = useState('')
  const [state, setState] = useState<'all' | AppState>('all')
  const [exposure, setExposure] = useState<'all' | AppStage>('all')

  const counts = useMemo(
    () => ({
      running: apps.filter((r) => r.status.state === 'running').length,
      attention: apps.filter((r) => r.status.state === 'attention').length,
      stopped: apps.filter((r) => r.status.state === 'stopped' || r.status.state === 'unknown')
        .length,
      // Not a state anything probes — nothing runs yet — so it is counted off
      // the registry rather than off prometheus: apps on their way to their
      // first container (lib/apps/setup.ts).
      settingUp: apps.filter((r) => r.isNew).length,
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

  const changed = [
    ...apps
      .filter((a) => !a.managedInNix && a.drift.length > 0)
      .map((a) => ({ name: a.name, fields: a.drift })),
    ...(data.siteChanges.length > 0 ? [{ name: 'site', fields: [...data.siteChanges] }] : []),
    ...(data.nodesChanges.length > 0 ? [{ name: 'nodes', fields: [...data.nodesChanges] }] : []),
  ]

  return (
    <>
      <div className={TOOLBAR}>
        <div className="relative max-w-[17rem] flex-[1_1_10rem]">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="h-8.5 pl-8.5 md:text-[0.82rem]"
            type="search"
            placeholder="Search apps"
            aria-label="Search apps"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
            }}
          />
        </div>
        {/* The state filter IS the tally: each option carries its count, so
            "how many are down" and "show me those" are one control. */}
        <SegmentPicker
          value={state}
          onChange={setState}
          label="Filter by state"
          // An empty state is not offered: "Issues 0" is a permanent slot for
          // nothing. It comes back the moment it counts, or while chosen.
          options={[
            { value: 'all' as const, label: 'All', count: apps.length },
            { value: 'running' as const, label: 'Running', count: counts.running },
            { value: 'attention' as const, label: 'Issues', count: counts.attention },
            { value: 'stopped' as const, label: 'Stopped', count: counts.stopped },
          ].filter(
            (o) =>
              o.value === 'all' ||
              o.value === state ||
              // Nothing to filter by when a state holds every app, or none.
              (o.count > 0 && o.count < apps.length),
          )}
        />
        {/* Second-order, so a dropdown: one control's width, not four. */}
        <Picker
          value={exposure}
          onChange={(v) => {
            setExposure(v as 'all' | AppStage)
          }}
          aria-label="Filter by exposure"
          className="h-8.5 w-auto gap-2.5 text-subdued data-[size=sm]:h-8.5"
          options={[
            { value: 'all', label: 'Any exposure' },
            ...APP_STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] })).reverse(),
          ]}
        />
        {/* Only when there are any: a zero here would be a permanent slot for
            a state most of the fleet is never in. */}
        {counts.settingUp > 0 && (
          <span
            className="inline-flex items-center gap-1.5 text-[0.8rem] text-muted-foreground"
            title="New apps on their way to their first container: registered, building, or starting. Each app's page says which."
          >
            <span aria-hidden="true">◌</span>
            <b className="font-[560] text-foreground tabular-nums">{counts.settingUp}</b> setting up
          </span>
        )}
      </div>

      <ul className={APP_TABLE} aria-label="Apps on this box">
        <AppTableHead />
        {managed.map((r) => (
          <AppRow key={r.name} row={r} />
        ))}
        {managed.length === 0 && (
          <li className="px-5 py-12 text-center text-[0.85rem] text-muted-foreground">
            No apps match that filter.
          </li>
        )}
        {/* The control plane is a group of its own at the foot of the table.
            It is not one of the things being managed — it is the thing doing
            the managing, declared by hand in Nix, every control on it
            read-only — so it is set apart rather than mixed in. */}
        {platform.length > 0 && <GroupRow title="Control plane" note="Declared in Nix" />}
        {platform.map((r) => (
          <AppRow key={r.name} row={r} />
        ))}
      </ul>

      {/* Projects hosted off the box, one table per platform, discovered
          from GitHub Pages and Vercel (core/offbox/). A platform that could
          not be read in full says why under its head — not connected, a
          permission not granted — with the place to fix it; one that has
          nothing to say and nothing to list is not drawn. */}
      {PLATFORMS.map((p) => {
        const entries = offBox.filter((e) => e.platform === p.id)
        const notes = offboxStatus.filter((s) => s.platform === p.id && s.state !== 'ok')
        if (entries.length === 0 && notes.length === 0) return null
        return (
          <div key={p.id}>
            <GroupHead icon={PLATFORM_ICONS[p.id]} title={p.id} sub={p.description} />
            {notes.length > 0 && (
              <ul className="m-0 mb-3 flex list-none flex-col gap-1.5 p-0 text-[0.8rem] text-subdued">
                {notes.map((n) => (
                  <li
                    key={`${n.account ?? ''}:${n.detail ?? ''}`}
                    className="flex items-center gap-2"
                  >
                    <StateDot state={n.state === 'error' ? 'attention' : 'unknown'} />
                    <span>
                      {n.account !== null && (
                        <b className="font-[560] text-foreground">{n.account}: </b>
                      )}
                      {n.detail}
                      {n.state !== 'error' && (
                        <>
                          {' — '}
                          <Link to="/settings" search={{ tab: 'integrations' }}>
                            Settings › Integrations
                          </Link>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {entries.length > 0 && (
              <ul className={APP_TABLE} aria-label={p.id}>
                <SiteTableHead />
                {entries.map((e) => (
                  <ExternalRow key={e.id} entry={e} />
                ))}
              </ul>
            )}
          </div>
        )
      })}

      <ApplyBar changed={changed} initialStatus={applyStatus} />
    </>
  )
}

function GroupHead({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <>
      <h2 className={cn(SECTION_TITLE, 'mt-10 first:mt-10')}>
        <span className="inline-flex text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
        {title}
      </h2>
      <p className={SECTION_NOTE}>{sub}</p>
    </>
  )
}
