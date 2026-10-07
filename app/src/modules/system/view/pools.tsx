import { Ago } from '../../../components/ago'
import { LogBoard } from '../../../components/logs'
import {
  CELL_MONO,
  CELL_QUIET,
  TABLE,
  TABLE_HEAD,
  TABLE_ROW,
  TableGroup,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import {
  EMPTY,
  FOOT,
  LIST,
  MONO,
  NOTE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  SUB,
} from '../../../components/tokens'
import { Board, BoardGrid, Chip, Facts, Measures, Progress } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, DASH, duration, num, pct } from '../../../lib/format'
import type { SystemData } from '../data'
import { SYSTEM_SNAPSHOT } from './shared'

/* ── Pools ────────────────────────────────────────────────────────────── */

type Pools = Extract<SystemData, { tab: 'pools' }>

const DS_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_7rem_7rem_6rem]',
  '@max-[34rem]/table:grid-cols-[minmax(0,1fr)_6rem]',
)
const DS_MID = '@max-[34rem]/table:hidden'
const DS_N = 'text-right tabular-nums'

export function PoolsView({ d }: { d: Pools }) {
  return (
    <div className="flex flex-col gap-10">
      <BoardGrid>
        {d.pools.map((p) => (
          <Board
            key={p.name}
            title={p.name}
            icon="panels"
            span={6}
            aside={
              p.health === 'ONLINE' ? (
                <span className={NOTE}>online</span>
              ) : (
                <Chip tone="bad">{p.health}</Chip>
              )
            }
          >
            <Progress pct={p.capacityPct} tone={p.capacityPct > 80 ? 'warn' : 'info'} />
            <Measures
              items={[
                { k: 'used', v: bytes(p.allocBytes) },
                { k: 'free', v: bytes(p.freeBytes) },
                { k: 'capacity', v: pct(p.capacityPct) },
                { k: 'fragmentation', v: pct(p.fragPct) },
              ]}
            />

            <h4 className={SUB}>Devices</h4>
            <ul className={LIST}>
              {p.vdevs.map((v) => (
                <li key={v.name} className={ROW}>
                  <span className={cn(ROW_MAIN, MONO)} title={v.name}>
                    {v.name}
                  </span>
                  <span className={ROW_SIDE}>
                    {v.state === 'ONLINE' ? 'online' : <Chip tone="warn">{v.state ?? '?'}</Chip>}
                  </span>
                </li>
              ))}
            </ul>

            <h4 className={SUB}>Last scrub</h4>
            {p.scrub === null ? (
              <p className={EMPTY}>never scrubbed</p>
            ) : (
              <Facts
                rows={[
                  {
                    k: 'Result',
                    v:
                      (p.scrub.errors ?? 0) === 0 ? (
                        'no errors'
                      ) : (
                        <Chip tone="bad">{num(p.scrub.errors)} errors</Chip>
                      ),
                  },
                  {
                    k: 'Finished',
                    v: p.scrub.endedAt === null ? DASH : <Ago at={p.scrub.endedAt * 1000} />,
                  },
                  {
                    k: 'Took',
                    v:
                      p.scrub.startedAt === null || p.scrub.endedAt === null
                        ? DASH
                        : duration(p.scrub.endedAt - p.scrub.startedAt),
                  },
                  { k: 'Read', v: bytes(p.scrub.examined) },
                ]}
              />
            )}
            <p className={FOOT}>
              Monthly, and it is the only thing that finds bit-rot: ZFS checksums every block on
              read, but a block nobody reads is never checked. On the mirror a bad copy is repaired
              from the good one; on the single-device pool a scrub can only report.
            </p>
          </Board>
        ))}
      </BoardGrid>

      {/* Every dataset in ONE table, grouped by its pool: the pool name is the
          group, so each row names only the part that differs, with the pool
          prefix in quiet ink. Sorted by size within each pool. */}
      <TableSection
        title="Datasets"
        aside={`${bytes(d.snapshotBytes)} in ${num(d.snapshots)} snapshots`}
      >
        <ul className={TABLE}>
          <li aria-hidden="true" className={cn(DS_GRID, TABLE_HEAD)}>
            <span>Dataset</span>
            <span className={cn(DS_N, DS_MID)}>Snapshots</span>
            <span className={cn(DS_N, DS_MID)}>Held by them</span>
            <span className={DS_N}>Used</span>
          </li>
          {d.pools
            .map((p) => p.name)
            .concat(
              [...new Set(d.datasets.map((ds) => ds.name.split('/')[0] ?? ''))].filter(
                (n) => !d.pools.some((p) => p.name === n),
              ),
            )
            .map((pool) => {
              const rows = d.datasets.filter((ds) => ds.name.split('/')[0] === pool)
              if (rows.length === 0) return null
              return [
                <TableGroup
                  key={`g-${pool}`}
                  title={pool}
                  note={`${String(rows.length)} datasets`}
                />,
                ...rows.map((ds) => (
                  <li key={ds.name} className={cn(DS_GRID, TABLE_ROW)}>
                    <span className={cn(CELL_MONO, 'text-[0.78rem]')} title={ds.name}>
                      <span className="text-muted-foreground/70">{pool}/</span>
                      <span className="text-foreground">{ds.name.slice(pool.length + 1)}</span>
                    </span>
                    <span className={cn(CELL_QUIET, DS_N, DS_MID)}>
                      {ds.snapshots === 0 ? 'not snapshotted' : num(ds.snapshots)}
                    </span>
                    <span className={cn(CELL_QUIET, DS_N, DS_MID)}>
                      {ds.snapshots === 0 ? DASH : bytes(ds.snapshotBytes)}
                    </span>
                    <span className={cn(DS_N, 'text-foreground')}>{bytes(ds.usedBytes)}</span>
                  </li>
                )),
              ]
            })}
        </ul>
        <p className={FOOT}>
          <b>Used</b> is the dataset plus everything its snapshots still pin; <b>held by them</b> is
          that second part alone, data no longer live but held because a snapshot references it.
          That column is the one to watch on <span className={MONO}>rpool/selfhost</span>: 16K
          recordsize under every container&rsquo;s database means its deltas are larger than
          intuition suggests, and the remedy if it grows is dropping a snapshot tier in{' '}
          <span className={MONO}>platform/zfs.nix</span>. The tiers are ring buffers, so count times
          cadence IS the retention window and a fully enrolled dataset settles at 39.
        </p>
      </TableSection>

      <BoardGrid>
        <LogBoard
          source={{ unit: 'zfs-converge.service' }}
          title="zfs-converge"
          neighbours={[
            SYSTEM_SNAPSHOT,
            {
              source: { unit: 'zfs-scrub.service' },
              label: 'Scrub',
              role: 'the monthly read of every block',
              note: 'Quiet unless it finds something. A missed run is the failure mode that matters, so this one is a dead-man’s-switch ping rather than a failure email: it reports to healthchecks and pages if it stops running entirely.',
            },
          ]}
          foot={
            <p className={FOOT}>
              Diffs the live dataset properties against the declaration on every rebuild and{' '}
              <span className={MONO}>zfs set</span>s only where they differ, so a silent run means
              reality already matched. It is wanted-by rather than required-by the mounts on
              purpose: a failed converge must never block <span className={MONO}>/s2</span>, and
              with it most of the container fleet.
            </p>
          }
        />
      </BoardGrid>
    </div>
  )
}
