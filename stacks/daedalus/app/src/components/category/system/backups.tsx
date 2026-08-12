import type { SystemData } from '../../../lib/dashboard/categories/system'
import { bytes, DASH, duration, num } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Board, BoardGrid } from '../../viz'
import { SYSTEM_SNAPSHOT } from './shared'

/* ── Backups ──────────────────────────────────────────────────────────── */

type Backups = Extract<SystemData, { tab: 'backups' }>

export function BackupsView({ d }: { d: Backups }) {
  return (
    <BoardGrid>
      <Board
        title="Replication"
        icon="⇉"
        span={8}
        aside={<span className="board-note">{bytes(d.totalReplicatedBytes)} on the mirror</span>}
      >
        {d.pairs.length === 0 ? (
          <p className="viz-empty">no replication pairs found</p>
        ) : (
          <ul className="itemlist">
            {d.pairs.map((p) => (
              <li key={p.target}>
                <span className="item-main mono">{p.source}</span>
                <span className="item-side mono">→ {p.target}</span>
                <span className="item-side">{num(p.targetSnapshots)} snapshots</span>
                <span className="item-n">
                  {p.lagSeconds === null ? (
                    DASH
                  ) : p.lagSeconds > 7200 ? (
                    <span className="text-warn">{duration(p.lagSeconds)} behind</span>
                  ) : (
                    `${duration(p.lagSeconds)} behind`
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="board-foot">
          syncoid runs hourly and rides the existing auto-snapshots rather than cutting its own, so
          a lag under an hour is the schedule rather than a fault — the source takes a snapshot
          every fifteen minutes and the replica catches the hourly one. It is a{' '}
          <b>mirror, not an archive</b>: it prunes whatever the source pruned, so a manual snapshot
          you keep on the source dies on the replica the moment its original is destroyed. That is
          also why the lag is the reading and &ldquo;the target has snapshots&rdquo; is not —
          syncoid exits 0 on a run that copied nothing.
        </p>
      </Board>

      <Board title="What is not covered" icon="warn" span={4}>
        {/* The honest half, and the reason this is a tab rather than a panel
            on Pools. Everything above is easy to show and easy to believe. */}
        <ul className="itemlist">
          <li>
            <span className="item-main">Off-site</span>
            <span className="item-side">nothing</span>
          </li>
          <li>
            <span className="item-main mono">acme.json</span>
            <span className="item-side">Let&rsquo;s Encrypt cert store</span>
          </li>
          <li>
            <span className="item-main mono">gravity.db</span>
            <span className="item-side">pi-hole&rsquo;s UI-added lists</span>
          </li>
        </ul>
        <p className="board-foot">
          Both pools are in this box, on this shelf. The mirror survives a drive; it does not
          survive a fire, a theft or a mistake that reaches both pools. The two files below it are
          outside the snapshot tree entirely — losing the cert store means re-issuing against
          Let&rsquo;s Encrypt&rsquo;s weekly rate limit. This is the biggest gap on the machine and
          it is stated here rather than left to be discovered.
        </p>
      </Board>

      <Board
        title="Snapshot coverage"
        icon="clock"
        span={8}
        aside={<span className="board-note">{num(d.coverage.length)} enrolled</span>}
      >
        <ul className="itemlist">
          {d.coverage.map((c) => (
            <li key={c.name}>
              <span className="item-main mono">{c.name}</span>
              <span className="item-side">{num(c.snapshots)} snapshots</span>
              <span className="item-n">{bytes(c.usedBytes)}</span>
            </li>
          ))}
        </ul>
      </Board>

      <Board title="Deliberately not snapshotted" icon="○" span={4}>
        {d.unsnapshotted.length === 0 ? (
          <p className="viz-empty">every dataset is enrolled</p>
        ) : (
          <ul className="itemlist">
            {d.unsnapshotted.map((u) => (
              <li key={u.name}>
                <span className="item-main mono">{u.name}</span>
                <span className="item-n">{bytes(u.usedBytes)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="board-foot">
          Opted out per dataset with <span className="mono">com.sun:auto-snapshot=false</span>. The
          media library is the big one and the reasoning is that it is re-downloadable —
          snapshotting a terabyte of files that can be fetched again buys nothing and costs the
          deltas.
        </p>
      </Board>

      <LogBoard
        source={{ unit: 'syncoid-rpool-selfhost.service' }}
        title="syncoid — selfhost"
        neighbours={[
          {
            source: { unit: 'syncoid-rpool-home.service' },
            label: 'syncoid — home',
            role: 'the other replication pair',
            note: 'Same schedule and the same flags. Both run --quiet, which drops syncoid’s progress-meter stage: the bundled pv aborts intermittently under headless piping and a crashed pv breaks the pipe and fails the whole replication.',
          },
          SYSTEM_SNAPSHOT,
        ]}
        foot={
          <p className="board-foot">
            Failures send mail; a run that stops happening at all pages through healthchecks, which
            is the failure this cannot detect itself. Both are declared in{' '}
            <span className="mono">platform/backup.nix</span>.
          </p>
        }
      />
    </BoardGrid>
  )
}
