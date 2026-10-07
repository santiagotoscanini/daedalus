// Network › General's two rankings — who moves the bytes, and what the house
// asks for — as the house table rather than bar lists inside boards.

import { useState } from 'react'
import {
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
  TableMore,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { cn } from '../../../lib/cn'
import { bytes, compact, pct } from '../../../lib/format'
import type { General, GeneralFacts } from './general'
import { CAPTION, FOOT } from './shared'

/** Service · split bar · in · out · total. The two directions step away first. */
const SERVICES_GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[minmax(7rem,11rem)_minmax(4rem,1fr)_4.5rem_4.5rem_5rem] @max-[38rem]/table:grid-cols-[minmax(6rem,10rem)_minmax(3rem,1fr)_5rem] @max-[38rem]/table:[&>.dir]:hidden'

/** Domain · share · lookups. The bar steps away on a narrow column. */
const DOMAINS_GRID =
  'grid items-center gap-x-5 px-5 grid-cols-[minmax(0,1fr)_minmax(2.5rem,4.5rem)_4rem] @max-[24rem]/table:grid-cols-[minmax(0,1fr)_4rem] @max-[24rem]/table:[&>.bar]:hidden'

/** A number column: right-aligned, tabular, quiet. */
const NUM = cn(CELL_QUIET, 'text-right')

/** How many rows a ranking shows before the tail folds. */
const TOP = 12

export function WhichServicesMoveTheBytesBoard({ f }: { f: GeneralFacts }) {
  const { services, moved } = f
  return (
    <TableSection
      className="col-span-8 max-[78rem]:col-span-12"
      title="Which services move the bytes"
      aside={`${bytes(moved)} over 24 hours`}
    >
      <TrafficTable rows={services} />
      <p className={FOOT}>
        Counted inside each container’s own network namespace, so this is traffic the app itself
        moved rather than a share of the total guessed from anything. Two kinds are absent by
        construction and not by omission: a container on the host’s network has no figures separable
        from the box, and the ten sharing <b>gluetun</b>’s namespace have none separable from each
        other; gluetun’s row is the whole download stack, counted as it crossed the wire encrypted.
      </p>
    </TableSection>
  )
}

/**
 * Per-container traffic, in and out on one row.
 *
 * Ranked by the two directions added together and drawn as one split bar,
 * because the question this answers is "who is using the network" and a
 * service that only ever uploads should not sort below one that does half as
 * much in both directions. The direction still shows: it is the split, and
 * the two columns beside it.
 */
function TrafficTable({ rows }: { rows: General['services'] }) {
  const [all, setAll] = useState(false)
  const ceiling = Math.max(...rows.map((r) => r.in + r.out), 1)
  const shown = all ? rows : rows.slice(0, TOP)
  const rest = rows.length - TOP

  return (
    <ul className={TABLE} aria-label="Traffic by container">
      <li className={cn(SERVICES_GRID, TABLE_HEAD)}>
        <span>Container</span>
        <span className="inline-flex items-center gap-3">
          <Key tone="in" label="in" />
          <Key tone="out" label="out" />
        </span>
        <span className="dir text-right">In</span>
        <span className="dir text-right">Out</span>
        <span className="text-right">Total, 24h</span>
      </li>
      {rows.length === 0 && <li className={TABLE_EMPTY}>no per-container counters yet</li>}
      {shown.map((r) => (
        <TrafficRow key={r.name} row={r} ceiling={ceiling} />
      ))}
      {rest > 0 && (
        <TableMore
          open={all}
          onToggle={() => {
            setAll((v) => !v)
          }}
          more={`${String(rest)} quieter container${rest === 1 ? '' : 's'}`}
          less="Show the top 12"
        />
      )}
    </ul>
  )
}

function Key({ tone, label }: { tone: 'in' | 'out'; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i
        className={cn('size-1.5 rounded-full', tone === 'in' ? 'bg-primary' : 'bg-info')}
        aria-hidden="true"
      />
      {label}
    </span>
  )
}

function TrafficRow({ row, ceiling }: { row: General['services'][number]; ceiling: number }) {
  const width = (n: number) => `${String((n / ceiling) * 100)}%`
  return (
    <li className={cn(SERVICES_GRID, TABLE_ROW_DENSE)}>
      <span className="truncate text-foreground" title={row.name}>
        {row.name}
      </span>
      <span className="flex h-1.5 min-w-0 overflow-hidden rounded-full bg-foreground/[0.06]">
        <span
          className="bg-primary"
          style={{ width: width(row.in) }}
          title={`${bytes(row.in)} in`}
        />
        <span
          className="bg-info"
          style={{ width: width(row.out) }}
          title={`${bytes(row.out)} out`}
        />
      </span>
      <span className={cn(NUM, 'dir')}>{bytes(row.in)}</span>
      <span className={cn(NUM, 'dir')}>{bytes(row.out)}</span>
      <span className="text-right text-foreground tabular-nums">{bytes(row.in + row.out)}</span>
    </li>
  )
}

export function WhatThisHouseAsksForBoard({ f }: { f: GeneralFacts }) {
  const { dns } = f
  const top = dns.topDomains
  const ceiling = Math.max(...top.map((d) => d.value), 1)
  return (
    <TableSection
      className="col-span-4 max-[78rem]:col-span-12"
      title="What this house asks for"
      aside={`${compact(dns.queries)} lookups today`}
    >
      <ul className={TABLE} aria-label="Most looked-up names">
        <li className={cn(DOMAINS_GRID, TABLE_HEAD)}>
          <span>Name</span>
          <span className="bar" />
          <span className="text-right">Lookups</span>
        </li>
        {top.length === 0 && <li className={TABLE_EMPTY}>no queries recorded</li>}
        {top.map((d) => (
          <li key={d.label} className={cn(DOMAINS_GRID, TABLE_ROW_DENSE)}>
            <span className="truncate text-foreground" title={d.label}>
              {d.label}
            </span>
            <span className="bar flex h-1.5 min-w-0 overflow-hidden rounded-full bg-foreground/[0.06]">
              <span
                className="rounded-full bg-primary/70"
                style={{ width: `${String(Math.max(3, (d.value / ceiling) * 100))}%` }}
              />
            </span>
            <span className="text-right text-foreground tabular-nums">
              {d.value.toLocaleString('en-US')}
            </span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        The names most looked up, which is the closest thing to a list of what this house depends on
        outside itself.
      </p>
      <p className={CAPTION}>
        {dns.fromBox === null || dns.queries === null
          ? 'Most of it is this box rather than the devices on the LAN.'
          : `${pct((dns.fromBox / dns.queries) * 100)} of it came from 127.0.0.1. Every container on this box resolves through the host’s stub, so pi-hole sees them as one client and no split by service is available from here.`}
      </p>
    </TableSection>
  )
}
