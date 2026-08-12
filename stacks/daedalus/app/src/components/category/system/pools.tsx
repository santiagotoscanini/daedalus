import type { SystemData } from '../../../lib/dashboard/categories/system'
import { bytes, DASH, duration, num, pct, since } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Board, BoardGrid, Chip, Facts, Measures, Progress } from '../../viz'
import { SYSTEM_SNAPSHOT } from './shared'

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

          <h4 className="board-sub">Devices</h4>
          <ul className="itemlist">
            {p.vdevs.map((v) => (
              <li key={v.name}>
                <span className="item-main mono" title={v.name}>
                  {v.name}
                </span>
                <span className="item-side">
                  {v.state === 'ONLINE' ? (
                    <Chip tone="ok">online</Chip>
                  ) : (
                    <Chip tone="warn">{v.state ?? '?'}</Chip>
                  )}
                </span>
              </li>
            ))}
          </ul>

          <h4 className="board-sub">Last scrub</h4>
          {p.scrub === null ? (
            <p className="viz-empty">never scrubbed</p>
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
          <p className="board-foot">
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
          <span className="board-note">
            {bytes(d.snapshotBytes)} in {num(d.snapshots)} snapshots
          </span>
        }
      >
        <ul className="itemlist">
          {d.datasets.map((ds) => (
            <li key={ds.name}>
              <span className="item-main mono">{ds.name}</span>
              <span className="item-side">
                {ds.snapshots === 0 ? 'not snapshotted' : `${String(ds.snapshots)} snapshots`}
              </span>
              <span className="item-side">{bytes(ds.snapshotBytes)} in them</span>
              <span className="item-n">{bytes(ds.usedBytes)}</span>
            </li>
          ))}
        </ul>
        <p className="board-foot">
          <b>Used</b> is the dataset plus everything its snapshots still pin; <b>in them</b> is that
          second part alone — data no longer live but held because a snapshot references it. That
          column is the one to watch on <span className="mono">rpool/selfhost</span>: 16K recordsize
          under every container&rsquo;s database means its deltas are larger than intuition
          suggests, and the remedy if it grows is dropping a snapshot tier in{' '}
          <span className="mono">platform/zfs.nix</span>. The tiers are ring buffers — count times
          cadence IS the retention window — so a fully enrolled dataset settles at 39.
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
            note: 'Quiet unless it finds something. A missed run is the failure mode that matters, so this one is a dead-man’s-switch ping rather than a failure email — it reports to healthchecks and pages if it stops running entirely.',
          },
        ]}
        foot={
          <p className="board-foot">
            Diffs the live dataset properties against the declaration on every rebuild and{' '}
            <span className="mono">zfs set</span>s only where they differ, so a silent run means
            reality already matched. It is wanted-by rather than required-by the mounts on purpose:
            a failed converge must never block <span className="mono">/s2</span>, and with it most
            of the container fleet.
          </p>
        }
      />
    </BoardGrid>
  )
}
