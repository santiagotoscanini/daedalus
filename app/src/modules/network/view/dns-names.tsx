// Network › DNS › Resolver: the names this house answers for itself, as the
// house table — pi-hole's hosts file joined to traefik's routers and the zone.

import { useState } from 'react'
import { Segmented } from '../../../components/controls'
import {
  CELL_MONO,
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import type { NetworkData } from '../data'
import { FOOT } from './shared'

type Lan = Extract<NetworkData, { tab: 'dns' }>['lan']

/** Name · answers with · zone · router. */
const GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[minmax(9rem,1.3fr)_minmax(7rem,1fr)_6rem_6rem] @max-[36rem]/table:grid-cols-[minmax(0,1fr)_auto] @max-[36rem]/table:gap-x-3 @max-[36rem]/table:[&>.ip]:hidden @max-[36rem]/table:[&>.zone]:hidden'

type Filter = 'all' | 'public' | 'unserved'

export function DeclaredNames({ lan }: { lan: Lan }) {
  const [filter, setFilter] = useState<Filter>('all')
  const unserved = lan.filter((n) => n.served === false)
  const pub = lan.filter((n) => n.public).length
  const shown = lan.filter((n) =>
    filter === 'all' ? true : filter === 'public' ? n.public : n.served === false,
  )

  return (
    <TableSection
      title="The names we declare"
      aside={`${String(lan.length)} entries · ${String(pub)} also public`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={filter}
          onChange={setFilter}
          label="Filter names"
          className="h-8.5 max-[40rem]:min-h-10"
          options={[
            { value: 'all' as const, label: 'All', count: lan.length },
            { value: 'public' as const, label: 'Public', count: pub },
            // The fault is offered only while it exists (or is chosen): a
            // permanent "No route 0" is a slot for nothing.
            ...(unserved.length > 0 || filter === 'unserved'
              ? [{ value: 'unserved' as const, label: 'No route', count: unserved.length }]
              : []),
          ]}
        />
      </div>

      <ul className={TABLE} aria-label="Names declared on the LAN">
        <li className={cn(GRID, TABLE_HEAD)}>
          <span>Name</span>
          <span className="ip">Answers with</span>
          <span className="zone">Zone</span>
          <span>Router</span>
        </li>
        {shown.length === 0 && <li className={TABLE_EMPTY}>No name matches that filter.</li>}
        {shown.map((n) => (
          <li key={n.fqdn} className={cn(GRID, TABLE_ROW_DENSE)} title={n.fqdn}>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-mono text-[0.76rem] text-foreground">{n.short}</span>
              {/* On a phone the address and zone columns are this second line. */}
              <span className="hidden truncate text-[0.75rem] text-muted-foreground @max-[36rem]/table:block">
                {n.elsewhere ? n.ip : 'this box'}
                {n.public && ' · public'}
              </span>
            </span>
            {/* This box is the norm, so it recedes; an entry pointing at
                another machine prints the address in full ink. */}
            {n.elsewhere ? (
              <span className={cn(CELL_MONO, 'ip text-foreground')}>{n.ip}</span>
            ) : (
              <span className={cn(CELL_QUIET, 'ip')}>this box</span>
            )}
            <span className={cn(CELL_QUIET, 'zone')}>{n.public ? 'public' : ''}</span>
            {/* The one state worth interrupting the list for. */}
            <span>{n.served === false && <Chip tone="bad">no route</Chip>}</span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        The names this house answers for itself instead of asking anyone. Each one is an entry in
        pi-hole’s hosts file generated from the stack that owns it, so a name gets here by being
        declared and never by being typed into the admin. Nothing in this list can outlive the thing
        it points at. <b>public</b> marks the ones the zone publishes as well, which is the same set
        the other side of this tab lists, seen from outside.
        {unserved.length === 0
          ? ' Everything pointed at this box has a traefik router behind it.'
          : ' A name marked no route resolves, then lands on the default certificate and 404s.'}
      </p>
    </TableSection>
  )
}
