// Network › Proxy's routing table: every published hostname, grouped by what
// protects it, as the house table.

import { useState } from 'react'
import { Segmented } from '../../../components/controls'
import {
  CELL_MONO,
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
  TableGroup,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { compact, DASH, num } from '../../../lib/format'
import type { Site } from '../../../lib/site'
import { stripBaseDomain } from '../../../lib/site'
import type { ProxyData } from './proxy'
import { CAPTION, FOOT } from './shared'

type Protection = ProxyData['routes'][number]['protection']

/** How each protection class reads, and in what order the table groups them. */
const PROTECTION: Record<Protection, { title: string; note: string }> = {
  app: {
    title: 'The app decides',
    note: 'traefik routes these straight through. Whatever login they have is their own, and this page cannot see it. Several of them do have one.',
  },
  gate: {
    title: 'Behind the gate',
    note: 'A forward-auth middleware. The request goes to Pocket ID first and only reaches the app once it has come back authenticated, so the app never sees an anonymous request at all.',
  },
  client: {
    title: 'Signs in against Pocket ID itself',
    note: 'No middleware. The app is a registered OIDC client and runs the login itself, which means it also decides what an unauthenticated request gets.',
  },
}

/** Hostname · reach · middleware · requests. The middleware steps away first. */
const GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[minmax(9rem,1.3fr)_6.5rem_minmax(7rem,1fr)_6rem] @max-[40rem]/table:grid-cols-[minmax(8rem,1fr)_6.5rem_5rem] @max-[40rem]/table:[&>.via]:hidden'

type Filter = 'all' | 'remote' | 'disabled'

export function PublishedTable({
  d,
  site,
  counts,
  groups,
  remote,
}: {
  d: ProxyData
  site: Site
  counts: ProxyData['counts']
  groups: { p: Protection; rows: ProxyData['routes'] }[]
  remote: number
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const disabled = d.routes.filter((r) => r.disabled).length
  const keep = (r: ProxyData['routes'][number]) =>
    filter === 'all' || (filter === 'remote' ? r.remote : r.disabled)
  const shown = groups
    .map((g) => ({ ...g, rows: g.rows.filter(keep) }))
    .filter((g) => g.rows.length > 0)

  return (
    <TableSection
      title="What is published, and what protects it"
      aside={`${String(d.routes.length)} hostnames · ${String(remote)} also off-LAN · requests over ${String(d.windowDays)} days`}
    >
      {/* The filter IS the tally: "how many can the internet ask" and "show
          me those" are one control. */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={filter}
          onChange={setFilter}
          label="Filter hostnames"
          className="h-8.5"
          options={[
            { value: 'all' as const, label: 'All', count: d.routes.length },
            { value: 'remote' as const, label: 'Off-LAN', count: remote },
            ...(disabled > 0 || filter === 'disabled'
              ? [{ value: 'disabled' as const, label: 'Disabled', count: disabled }]
              : []),
          ]}
        />
      </div>

      <ul className={TABLE} aria-label="Published hostnames">
        <li className={cn(GRID, TABLE_HEAD)}>
          <span>Hostname</span>
          <span>Reach</span>
          <span className="via">Middleware</span>
          <span className="text-right">Requests</span>
        </li>
        {shown.length === 0 && <li className={TABLE_EMPTY}>No hostname matches that filter.</li>}
        {shown.map((g) => (
          <Group key={g.p} title={PROTECTION[g.p].title} rows={g.rows} site={site} />
        ))}
      </ul>

      {/* What each group means: prose, so it folds behind the ⓘ. */}
      <dl className="explain m-0 grid gap-x-6 gap-y-2 text-[0.78rem] leading-[1.55] text-muted-foreground md:grid-cols-3">
        {groups.map((g) => (
          <div key={g.p}>
            <dt className="text-subdued [font-weight:560]">{PROTECTION[g.p].title}</dt>
            <dd className="m-0">{PROTECTION[g.p].note}</dd>
          </div>
        ))}
      </dl>
      <p className={FOOT}>
        One row per hostname rather than per router, because a name published both on the LAN and
        through the tunnel is two routers for one thing. Read from the configuration traefik built,
        not from what the flake asked for, which is the point of looking. The count on the right is
        requests over {d.windowDays} days.
      </p>
      {counts.errors > 0 && (
        <p className={cn(CAPTION, 'text-warning')}>
          <b>
            {num(counts.errors)} piece{counts.errors === 1 ? '' : 's'} of configuration failed to
            build.
          </b>{' '}
          A router that does not exist answers nothing, quietly.
        </p>
      )}
    </TableSection>
  )
}

function Group({ title, rows, site }: { title: string; rows: ProxyData['routes']; site: Site }) {
  return (
    <>
      <TableGroup title={title} note={String(rows.length)} />
      {rows.map((r) => (
        <li key={r.host} className={cn(GRID, TABLE_ROW_DENSE)}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-[0.76rem] text-foreground">
              {stripBaseDomain(site, r.host)}
            </span>
            {r.disabled && <Chip tone="bad">disabled</Chip>}
          </span>
          {/* Off-LAN is the exception that matters — the internet can ask —
              so it is the only reach with ink. LAN-only is the quiet norm. */}
          <span>
            {r.remote ? (
              <Chip tone="warn">off-LAN</Chip>
            ) : (
              <span className={CELL_QUIET}>LAN only</span>
            )}
          </span>
          <span className={cn(CELL_MONO, 'via')} title={r.via ?? undefined}>
            {r.via ?? ''}
          </span>
          {/* An em dash is not zero: traefik labels no request counters for
              its own dashboard's router, and a 0 there would read as "nobody
              has opened it". */}
          <span className="text-right text-foreground tabular-nums">
            {r.requests === null ? DASH : compact(r.requests)}
          </span>
        </li>
      ))}
    </>
  )
}
