// The apps list: tallies by state, a card per app, and the projects off the box.

import { Link } from '@tanstack/react-router'
import { type ReactNode, useMemo, useState } from 'react'
import { cn } from '../../lib/cn'
import { PLATFORMS } from '../../lib/external-apps'
import type { AppStage } from '../../lib/stage'
import type { fetchAppsTab } from '../../routes/apps.index'
import { ApplyBar } from '../apply-bar'
import { AppIcon, type AppState, Segmented, StateDot } from '../controls'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { AppRow, ExternalRow, PLATFORM_ICONS } from './app-card'
import { SECTION_HEAD, SECTION_HEAD_SMALL } from './shared'

type ListData = Awaited<ReturnType<typeof fetchAppsTab>>
export type Row = ListData['apps'][number]
export type ExternalEntry = ListData['external'][number]

/* A grid of project cards, not rows: a row spends a 1200px line on five
   facts with a gap in the middle, where a card puts them in ~300px, three or
   four abreast, and collapses to one column on a phone with no special-casing
   — which is also why there is no narrow-viewport rule for it.

   Exported for `RowsSkeleton`, so the placeholder reserves this grid and not
   an approximation of it. */
export const APP_LIST =
  'm-0 grid list-none grid-cols-[repeat(auto-fill,minmax(min(19rem,100%),1fr))] gap-[0.8rem] p-0'

const TALLIES =
  'mb-[1.1rem] flex flex-wrap items-center gap-x-[1.6rem] gap-y-2 text-[0.88rem] text-subdued max-[34rem]:gap-x-4 max-[34rem]:gap-y-[0.4rem]'
const TALLY = 'inline-flex items-center gap-[0.45rem]'
const TALLY_COUNT = 'font-semibold text-foreground'

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
      // Not a state anything probes — nothing is running to probe — so it is
      // counted off the registry rather than off prometheus. It is the one
      // tally that is a to-do: these are waiting to be built and promoted.
      declared: apps.filter((r) => r.stage === 'declared').length,
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
      <div className={TALLIES}>
        <span className={TALLY}>
          <StateDot state="running" /> <b className={TALLY_COUNT}>{counts.running}</b> running
        </span>
        <span className={TALLY}>
          <StateDot state="attention" /> <b className={TALLY_COUNT}>{counts.attention}</b> need
          attention
        </span>
        <span className={TALLY}>
          <StateDot state="stopped" /> <b className={TALLY_COUNT}>{counts.stopped}</b> stopped
        </span>
        {/* Only when there are any: a zero here would be a permanent slot for
            a state most of the fleet is never in. Clicking it filters, because
            the next thing anybody does with this number is go look. */}
        {counts.declared > 0 && (
          <Button
            type="button"
            variant="link"
            className={cn(TALLY, 'h-auto p-0 font-normal text-inherit text-[length:inherit]')}
            title="Declared only: no container, no ingress. Build the repo, then set exposure on the app’s page."
            onClick={() => {
              setExposure('declared')
            }}
          >
            <span aria-hidden="true" className="text-muted-foreground">
              ◌
            </span>{' '}
            <b className={TALLY_COUNT}>{counts.declared}</b> declared
          </Button>
        )}
        {/* The create flow is a page rather than a dialog: it makes a GitHub
            round trip per repo it checks, and a checklist you can leave open
            in a tab while you go fix the repo is worth more than one that
            closes when you click outside it. Parked at the end of the tally
            line rather than in the page header — the header is shared by all
            three tabs, and adding an app is only one of them. */}
        <Button asChild size="sm" className="ml-auto">
          <Link to="/apps/new">Add an app</Link>
        </Button>
      </div>

      <div className="mb-[1.3rem] flex flex-wrap gap-[0.6rem]">
        <Input
          className="flex-[1_1_15rem]"
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
            { value: 'declared', label: 'declared' },
          ]}
        />
      </div>

      <SectionHead
        icon={<AppIcon name="daedalus" hasIcon={selfHasIcon} size={15} />}
        title="Daedalus"
        sub="deployed, watched and managed on this box"
      />
      <ul className={APP_LIST}>
        {managed.map((r) => (
          <AppRow key={r.name} row={r} />
        ))}
        {managed.length === 0 && (
          <li className="py-10 text-muted-foreground">No apps match that filter.</li>
        )}
      </ul>

      {/* The control plane sits below its own rule rather than in the list.
          It is not one of the things being managed — it is the thing doing the
          managing, it is declared by hand in Nix, and every control on it is
          read-only. Mixing it in invites you to try editing it. */}
      {platform.length > 0 && (
        <>
          <h2 className={SECTION_HEAD}>
            Control plane
            <small className={SECTION_HEAD_SMALL}>declared in Nix, not editable here</small>
          </h2>
          <ul className={APP_LIST}>
            {platform.map((r) => (
              <AppRow key={r.name} row={r} aside />
            ))}
          </ul>
        </>
      )}

      {/* Projects hosted off the box, one section per platform, discovered
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
            <SectionHead icon={PLATFORM_ICONS[p.id]} title={p.id} sub={p.description} />
            {notes.length > 0 && (
              <ul className="m-0 mb-[0.8rem] list-none p-0 text-[0.82rem] text-subdued">
                {notes.map((n) => (
                  <li
                    key={`${n.account ?? ''}:${n.detail ?? ''}`}
                    className="flex items-center gap-2"
                  >
                    <StateDot state={n.state === 'error' ? 'attention' : 'unknown'} />
                    <span>
                      {n.account !== null && <b className="font-medium">{n.account}: </b>}
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
              <ul className={APP_LIST}>
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

function SectionHead({ icon, title, sub }: { icon: ReactNode; title: string; sub: string }) {
  return (
    <h2 className={SECTION_HEAD}>
      {/* Centred by hand because the head aligns its text on the baseline,
          which an image does not have. */}
      <span className="inline-flex self-center text-subdued" aria-hidden="true">
        {icon}
      </span>
      {title}
      <small className={SECTION_HEAD_SMALL}>{sub}</small>
    </h2>
  )
}
