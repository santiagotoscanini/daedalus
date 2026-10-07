import { LogBoard } from '../../../components/logs'
import {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  CELL_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableGroup,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { FOOT, MONO, MONO_FACE } from '../../../components/tokens'
import { BoardGrid } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, DASH, duration, num } from '../../../lib/format'
import type { SystemData } from '../data'
import { SYSTEM_SNAPSHOT } from './shared'

/* ── Backups ──────────────────────────────────────────────────────────── */

type Backups = Extract<SystemData, { tab: 'backups' }>

// Three tables, in the order of the question "what survives this machine":
// what is copied (and how far behind), what is NOT covered at all — the honest
// half, kept second so it is never below the fold of the easy half — and which
// datasets the snapshots enrol. Lag is the reading on the first; it is the one
// column that takes colour, and only once it is late.

const N = 'text-right tabular-nums'

const PAIR_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_6.5rem_7.5rem]',
  '@max-[40rem]/table:grid-cols-[minmax(0,1fr)_7.5rem]',
)
const PAIR_MID = '@max-[40rem]/table:hidden'

const GAP_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,14rem)_minmax(0,1fr)]',
  '@max-[30rem]/table:grid-cols-[minmax(0,1fr)]',
)

/** The gap's reason, under its name, once the second column has gone. */
const GAP_PHONE = 'hidden whitespace-normal! @max-[30rem]/table:block'

const COVER_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_6.5rem_6rem]',
  '@max-[30rem]/table:grid-cols-[minmax(0,1fr)_6rem]',
)
const COVER_MID = '@max-[30rem]/table:hidden'

export function BackupsView({ d }: { d: Backups }) {
  return (
    <div className="flex flex-col gap-10">
      <TableSection
        title="Replication"
        aside={`${bytes(d.totalReplicatedBytes)} on the mirror · syncoid, hourly`}
      >
        <ul className={TABLE}>
          <li aria-hidden="true" className={cn(PAIR_GRID, TABLE_HEAD)}>
            <span>Source</span>
            <span className={PAIR_MID}>Replica</span>
            <span className={cn(N, PAIR_MID)}>Snapshots</span>
            <span className={N}>Lag</span>
          </li>
          {d.pairs.length === 0 && <li className={TABLE_EMPTY}>no replication pairs found</li>}
          {d.pairs.map((p) => (
            <li key={p.target} className={cn(PAIR_GRID, TABLE_ROW)}>
              <span className="flex min-w-0 flex-col">
                <span className={cn(CELL_NAME, MONO_FACE, 'text-[0.8rem]')}>{p.source}</span>
                {/* The replica and its snapshot count, under the source, where the
                    columns for them have stepped away. */}
                <span className="hidden text-[0.72rem] text-muted-foreground [overflow-wrap:anywhere] @max-[40rem]/table:block">
                  → {p.target} · {num(p.targetSnapshots)} snapshots
                </span>
              </span>
              <span className={cn(CELL_MONO, PAIR_MID)}>
                <span className="mr-1.5">→</span>
                {p.target}
              </span>
              <span className={cn(CELL_QUIET, N, PAIR_MID)}>{num(p.targetSnapshots)}</span>
              <span className={cn(N, 'text-[0.8125rem]')}>
                {p.lagSeconds === null ? (
                  <span className="text-muted-foreground">{DASH}</span>
                ) : p.lagSeconds > 7200 ? (
                  <span className="text-warning">{duration(p.lagSeconds)} behind</span>
                ) : (
                  <span className="text-foreground">{duration(p.lagSeconds)} behind</span>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className={FOOT}>
          syncoid runs hourly and rides the existing auto-snapshots rather than cutting its own, so
          a lag under an hour is the schedule rather than a fault. The source takes a snapshot every
          fifteen minutes and the replica catches the hourly one. It is a{' '}
          <b>mirror, not an archive</b>: it prunes whatever the source pruned, so a manual snapshot
          you keep on the source dies on the replica the moment its original is destroyed. That is
          also why the lag is the reading and &ldquo;the target has snapshots&rdquo; is not. syncoid
          exits 0 on a run that copied nothing.
        </p>
      </TableSection>

      {/* The honest half, and the reason this is a tab rather than a panel on
          Pools. Everything above is easy to show and easy to believe. */}
      <TableSection title="What is not covered" aside="3 gaps">
        <ul className={TABLE}>
          <li aria-hidden="true" className={cn(GAP_GRID, TABLE_HEAD)}>
            <span>What</span>
            <span className={COVER_MID}>Why it matters</span>
          </li>
          <li className={cn(GAP_GRID, TABLE_ROW)}>
            <span className="flex min-w-0 flex-col">
              <span className={CELL_NAME}>Off-site</span>
              <span className={cn(CELL_SUB, GAP_PHONE)}>nothing — both pools are in this box</span>
            </span>
            <span className={cn(CELL_QUIET, COVER_MID)}>nothing — both pools are in this box</span>
          </li>
          <li className={cn(GAP_GRID, TABLE_ROW)}>
            <span className="flex min-w-0 flex-col">
              <span className={cn(CELL_NAME, MONO_FACE, 'text-[0.8rem]')}>acme.json</span>
              <span className={cn(CELL_SUB, GAP_PHONE)}>Let&rsquo;s Encrypt cert store</span>
            </span>
            <span className={cn(CELL_QUIET, COVER_MID)}>Let&rsquo;s Encrypt cert store</span>
          </li>
          <li className={cn(GAP_GRID, TABLE_ROW)}>
            <span className="flex min-w-0 flex-col">
              <span className={cn(CELL_NAME, MONO_FACE, 'text-[0.8rem]')}>gravity.db</span>
              <span className={cn(CELL_SUB, GAP_PHONE)}>pi-hole&rsquo;s UI-added lists</span>
            </span>
            <span className={cn(CELL_QUIET, COVER_MID)}>pi-hole&rsquo;s UI-added lists</span>
          </li>
        </ul>
        <p className={FOOT}>
          Both pools are in this box, on this shelf. The mirror survives a drive; it does not
          survive a fire, a theft or a mistake that reaches both pools. The two files below it are
          outside the snapshot tree entirely, and losing the cert store means re-issuing against
          Let&rsquo;s Encrypt&rsquo;s weekly rate limit. This is the biggest gap on the machine.
        </p>
      </TableSection>

      <TableSection
        title="Snapshot coverage"
        aside={`${num(d.coverage.length)} enrolled · ${num(d.unsnapshotted.length)} opted out`}
      >
        <ul className={TABLE}>
          <li aria-hidden="true" className={cn(COVER_GRID, TABLE_HEAD)}>
            <span>Dataset</span>
            <span className={cn(N, COVER_MID)}>Snapshots</span>
            <span className={N}>Used</span>
          </li>
          <TableGroup title="Enrolled" note={`${num(d.coverage.length)} datasets`} />
          {d.coverage.map((c) => (
            <li key={c.name} className={cn(COVER_GRID, TABLE_ROW)}>
              <span className="flex min-w-0 flex-col">
                <span className={cn(CELL_MONO, 'text-[0.78rem] text-foreground')}>{c.name}</span>
                <span className="hidden text-[0.72rem] text-muted-foreground @max-[30rem]/table:block">
                  {num(c.snapshots)} snapshots
                </span>
              </span>
              <span className={cn(CELL_QUIET, N, COVER_MID)}>{num(c.snapshots)}</span>
              <span className={cn(N, 'text-foreground')}>{bytes(c.usedBytes)}</span>
            </li>
          ))}
          <TableGroup
            title="Deliberately not snapshotted"
            note={d.unsnapshotted.length === 0 ? 'none' : `${num(d.unsnapshotted.length)} datasets`}
          />
          {d.unsnapshotted.length === 0 && (
            <li className={TABLE_EMPTY}>every dataset is enrolled</li>
          )}
          {d.unsnapshotted.map((u) => (
            <li key={u.name} className={cn(COVER_GRID, TABLE_ROW)}>
              <span className={cn(CELL_MONO, 'text-[0.78rem]')}>{u.name}</span>
              <span className={cn(CELL_QUIET, N, COVER_MID)}>{DASH}</span>
              <span className={cn(N, 'text-subdued')}>{bytes(u.usedBytes)}</span>
            </li>
          ))}
        </ul>
        <p className={FOOT}>
          Opted out per dataset with <span className={MONO}>com.sun:auto-snapshot=false</span>. The
          media library is the big one, and it is re-downloadable: snapshotting a terabyte of files
          that can be fetched again buys nothing and costs the deltas.
        </p>
      </TableSection>

      <BoardGrid>
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
            <p className={FOOT}>
              Failures send mail; a run that stops happening at all pages through healthchecks,
              which is the failure this cannot detect itself. Both are declared in{' '}
              <span className={MONO}>platform/backup.nix</span>.
            </p>
          }
        />
      </BoardGrid>
    </div>
  )
}
