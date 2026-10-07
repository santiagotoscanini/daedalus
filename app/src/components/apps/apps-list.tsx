// The apps list: a toolbar whose filters are the tallies, a table of the apps
// this box runs, the control plane, and the projects off the box.

import { Link } from '@tanstack/react-router'
import { SearchIcon } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { PLATFORMS } from '../../lib/external-apps'
import { APP_STAGES, type AppStage, STAGE_LABEL } from '../../lib/stage'
import type { fetchAppsTab } from '../../routes/apps.index'
import { ApplyBar } from '../apply-bar'
import { AppIcon, type AppState, StateDot } from '../controls'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import {
  APP_TABLE,
  AppRow,
  AppTableHead,
  ExternalRow,
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
const TOOLBAR = 'mb-5 flex flex-wrap items-center gap-2.5'

/** A group's name above its table, with its note. */
const GROUP =
  'mt-10 mb-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.8125rem] text-foreground [font-weight:560]'
const GROUP_NOTE = 'text-[0.78rem] font-normal text-muted-foreground'

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

  // The control plane's own row carries whether it serves an icon, so the
  // section head borrows it rather than probing again.
  const selfHasIcon = apps.find((a) => a.name === 'daedalus')?.hasIcon ?? false

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
        <div className="relative flex-[0_1_18rem] max-[40rem]:flex-[1_1_100%]">
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
          options={[
            { value: 'all', label: 'All', count: apps.length },
            { value: 'running', label: 'Running', count: counts.running },
            { value: 'attention', label: 'Issues', count: counts.attention },
            { value: 'stopped', label: 'Stopped', count: counts.stopped },
          ]}
        />
        <SegmentPicker
          value={exposure}
          onChange={setExposure}
          label="Filter by exposure"
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
        {/* The create flow is a page rather than a dialog: it makes a GitHub
            round trip per repo it checks, and a checklist you can leave open
            in a tab while you go fix the repo is worth more than one that
            closes when you click outside it. On the toolbar rather than in
            the page header — the header is shared by all four tabs, and
            adding an app is only this one's. */}
        <Button asChild className="ml-auto">
          <Link to="/apps/new">Add an app</Link>
        </Button>
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
      </ul>

      {/* The control plane sits in its own table rather than in the list.
          It is not one of the things being managed — it is the thing doing
          the managing, it is declared by hand in Nix, and every control on it
          is read-only. Mixing it in invites you to try editing it. */}
      {platform.length > 0 && (
        <>
          <GroupHead
            icon={<AppIcon name="daedalus" hasIcon={selfHasIcon} size={15} />}
            title="Control plane"
            sub="declared in Nix, not editable here"
          />
          <ul className={APP_TABLE} aria-label="Control plane">
            <AppTableHead />
            {platform.map((r) => (
              <AppRow key={r.name} row={r} />
            ))}
          </ul>
        </>
      )}

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
    <h2 className={GROUP}>
      <span className="inline-flex text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      {title}
      <small className={GROUP_NOTE}>{sub}</small>
    </h2>
  )
}
