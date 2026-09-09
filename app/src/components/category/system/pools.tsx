import { cn } from '../../../lib/cn'
import type { SystemData } from '../../../lib/dashboard/categories/system'
import { bytes, DASH, duration, num, pct, since } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Board, BoardGrid, Chip, Facts, Measures, Progress } from '../../viz'
import {
  BOARD_FOOT,
  BOARD_NOTE,
  BOARD_SUB,
  LIST,
  MONO,
  ROW,
  ROW_MAIN,
  ROW_N,
  ROW_SIDE,
  SYSTEM_SNAPSHOT,
  VIZ_EMPTY,
} from './shared'

/* ── Pools ────────────────────────────────────────────────────────────── */

type Pools = Extract<SystemData, { tab: 'pools' }>

export function PoolsView({ d }: { d: Pools }) {
  return (
    <BoardGrid>
      {d.pools.map((p) => (
        <Board
          key={p.name}
          title={p.name}
          icon="panels"
          span={6}
          aside={
            p.health === 'ONLINE' ? (
              <Chip tone="ok">online</Chip>
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

          <h4 className={BOARD_SUB}>Devices</h4>
          <ul className={LIST}>
            {p.vdevs.map((v) => (
              <li key={v.name} className={ROW}>
                <span className={cn(ROW_MAIN, MONO)} title={v.name}>
                  {v.name}
                </span>
                <span className={ROW_SIDE}>
                  {v.state === 'ONLINE' ? (
                    <Chip tone="ok">online</Chip>
                  ) : (
                    <Chip tone="warn">{v.state ?? '?'}</Chip>
                  )}
                </span>
              </li>
            ))}
          </ul>

          <h4 className={BOARD_SUB}>Last scrub</h4>
          {p.scrub === null ? (
            <p className={VIZ_EMPTY}>never scrubbed</p>
          ) : (
            <Facts
              rows={[
                {
                  k: 'Result',
                  v:
                    (p.scrub.errors ?? 0) === 0 ? (
                      <Chip tone="ok">no errors</Chip>
                    ) : (
                      <Chip tone="bad">{num(p.scrub.errors)} errors</Chip>
                    ),
                },
                {
                  k: 'Finished',
                  v: p.scrub.endedAt === null ? DASH : since(Date.now() / 1000 - p.scrub.endedAt),
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
          <p className={BOARD_FOOT}>
            Monthly, and it is the only thing that finds bit-rot: ZFS checksums every block on read,
            but a block nobody reads is never checked. On the mirror a bad copy is repaired from the
            good one; on the single-device pool a scrub can only report.
          </p>
        </Board>
      ))}

      <Board
        title="Datasets"
        icon="rows"
        span={12}
        aside={
          <span className={BOARD_NOTE}>
            {bytes(d.snapshotBytes)} in {num(d.snapshots)} snapshots
          </span>
        }
      >
        <ul className={LIST}>
          {d.datasets.map((ds) => (
            <li key={ds.name} className={ROW}>
              <span className={cn(ROW_MAIN, MONO)}>{ds.name}</span>
              <span className={ROW_SIDE}>
                {ds.snapshots === 0 ? 'not snapshotted' : `${String(ds.snapshots)} snapshots`}
              </span>
              <span className={ROW_SIDE}>{bytes(ds.snapshotBytes)} in them</span>
              <span className={ROW_N}>{bytes(ds.usedBytes)}</span>
            </li>
          ))}
        </ul>
        <p className={BOARD_FOOT}>
          <b>Used</b> is the dataset plus everything its snapshots still pin; <b>in them</b> is that
          second part alone, data no longer live but held because a snapshot references it. That
          column is the one to watch on <span className={MONO}>rpool/selfhost</span>: 16K recordsize
          under every container&rsquo;s database means its deltas are larger than intuition
          suggests, and the remedy if it grows is dropping a snapshot tier in{' '}
          <span className={MONO}>platform/zfs.nix</span>. The tiers are ring buffers, so count times
          cadence IS the retention window and a fully enrolled dataset settles at 39.
        </p>
      </Board>

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
          <p className={BOARD_FOOT}>
            Diffs the live dataset properties against the declaration on every rebuild and{' '}
            <span className={MONO}>zfs set</span>s only where they differ, so a silent run means
            reality already matched. It is wanted-by rather than required-by the mounts on purpose:
            a failed converge must never block <span className={MONO}>/s2</span>, and with it most
            of the container fleet.
          </p>
        }
      />
    </BoardGrid>
  )
}
