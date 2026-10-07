import { LogBoard } from '../../../components/logs'
import { PartHead } from '../../../components/part'
import {
  CELL_MONO,
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { EMPTY, FOOT, MONO, NOTE, SUB } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Progress } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, DASH, num, pct } from '../../../lib/format'
import type { SystemData } from '../data'
import { HOST_READERS, PARTS } from './shared'

/* ── Memory ───────────────────────────────────────────────────────────── */

type Memory = Extract<SystemData, { tab: 'memory' }>

// Reading order, each row a pair of related heights:
//
//   Memory (available, large; then ZFS's share of it) ··· The modules
//   Heaviest containers ································· Pressure that happened
//   Caps (a table: one row per capped container)
//   Kernel
//
// The focal point is AVAILABLE, the reading the Memory board's own note says
// to read — not "used", which ZFS's cache makes look alarming on purpose.

const HEADLINE =
  'm-0 text-[2.25rem] leading-none tracking-[-0.035em] text-foreground tabular-nums [font-weight:560]'

export function MemoryView({ d }: { d: Memory }) {
  return (
    <div className="flex flex-col gap-10">
      <BoardGrid>
        <MemoryBoard d={d} />

        {/* The sticks behind the bar beside. Every other number on this tab is
            bytes in flight; this is what they are flying through, and it is the
            only panel here that answers "can I add more" — which is the question
            a memory page gets asked when the bar looks full. */}
        <TheModulesBoard d={d} />

        <Board title="Heaviest containers" icon="grid" span={8}>
          <BarList items={d.topMemory} tone="muted" empty="nothing reporting" />
          <p className={FOOT}>
            This is <span className={MONO}>memory.current</span>, which <b>includes page cache</b>.
            A container doing file I/O sits near its limit forever and is perfectly healthy; the
            cache is reclaimed when something else needs it. The number that means a cap is too
            tight is the OOM count beside this one, not this bar.
          </p>
        </Board>

        <AfterTheFactBoard d={d} />
      </BoardGrid>

      <CapsSection d={d} />

      {/* The kernel is the right stream for this tab: an OOM kill, a zram
          allocation failure and ZFS shrinking the ARC under pressure are all
          kernel lines and appear in no container's log — including the log of
          the container that was killed. */}
      <BoardGrid>
        <KernelBoard />
      </BoardGrid>
    </div>
  )
}

function MemoryBoard({ d }: { d: Memory }) {
  const arcShare = d.arc.size === null || d.total === null ? null : (d.arc.size / d.total) * 100
  return (
    <Board
      title="Memory"
      icon="rows"
      span={8}
      aside={<span className={NOTE}>{bytes(d.total)} total</span>}
    >
      <div className="flex flex-col gap-1.5">
        <span className="text-[0.75rem] text-muted-foreground">available</span>
        <p className={HEADLINE}>{bytes(d.available)}</p>
      </div>
      <Progress
        pct={d.total === null || d.used === null ? null : (d.used / d.total) * 100}
        tone="muted"
      />
      <Measures
        items={[
          { k: 'used', v: bytes(d.used) },
          { k: 'page cache', v: bytes(d.cached) },
          { k: 'dirty', v: bytes(d.dirty) },
        ]}
      />
      <p className={FOOT}>
        Read <b>available</b>, not used. Linux spends free memory on cache by design, so a box with
        nothing to do still reports most of its memory in use. On this one a large share of that is
        ZFS&rsquo;s cache, which is charged to the kernel and handed back on demand.
      </p>

      {/* The panel that makes the bar above readable, so it lives under it. */}
      <h4 className={SUB}>ZFS cache</h4>
      <Progress
        pct={d.arc.size === null || d.arc.max === null ? null : (d.arc.size / d.arc.max) * 100}
        tone="muted"
      />
      <Measures
        items={[
          { k: 'ARC now', v: bytes(d.arc.size) },
          { k: 'ceiling', v: bytes(d.arc.max) },
          { k: 'share of RAM', v: pct(arcShare) },
          { k: 'hit rate (30m)', v: pct(d.arc.hitRate, 1) },
        ]}
      />
      <p className={FOOT}>
        The single biggest consumer on this box and the reason &ldquo;used&rdquo; looks alarming.
        ARC grows to fill what nothing else wants and shrinks under pressure. A high hit rate here
        is what keeps the pools from being asked.
      </p>
    </Board>
  )
}

function TheModulesBoard({ d }: { d: Memory }) {
  return (
    <Board
      title="The modules"
      icon="rows"
      span={4}
      aside={
        <span className={NOTE}>
          {d.modules.populated === null || d.modules.slots === null
            ? DASH
            : `${num(d.modules.populated)} of ${num(d.modules.slots)} slots`}
        </span>
      }
    >
      <PartHead part={PARTS.memory} />
      <Facts
        rows={[
          {
            k: 'Installed',
            v:
              d.modules.totalGb === null
                ? DASH
                : `${num(d.modules.totalGb)} GB ${d.modules.modules[0]?.type ?? ''}`.trim(),
          },
          {
            k: 'Speed',
            v:
              d.modules.modules[0]?.speedMts == null
                ? DASH
                : `${num(d.modules.modules[0].speedMts)} MT/s`,
          },
          {
            k: 'Part',
            v: <span className={MONO}>{d.modules.modules[0]?.partNumber ?? DASH}</span>,
          },
          {
            k: 'Room left',
            v:
              d.modules.maxCapacityGb === null || d.modules.totalGb === null
                ? DASH
                : `${num(d.modules.maxCapacityGb - d.modules.totalGb)} GB in ${num(
                    (d.modules.slots ?? 0) - (d.modules.populated ?? 0),
                  )} slots`,
          },
        ]}
      />
      <p className={FOOT}>
        Read from SMBIOS rather than counted from bytes: the kernel knows how much memory it has and
        nothing about how it arrives. Two slots free against a 128 GB ceiling is the headroom this
        machine has. The full specification is on <b>Build</b>.
      </p>
    </Board>
  )
}

/**
 * The two readings of pressure that already happened: kills, and swap. Both
 * are zero on a healthy box and both are invisible to an instantaneous gauge,
 * which is why they share a board — and why each takes colour only once it
 * has moved.
 */
function AfterTheFactBoard({ d }: { d: Memory }) {
  const zramUsed = d.zram.used ?? 0
  return (
    <Board
      title="OOM kills"
      icon="warn"
      span={4}
      aside={
        d.oomKills === null ? (
          <span className={NOTE}>{DASH}</span>
        ) : d.oomKills > 0 ? (
          <Chip tone="warn">{num(d.oomKills)} all time</Chip>
        ) : (
          <span className={NOTE}>none, ever</span>
        )
      }
    >
      {/* The total tells "never" from "unreachable" — the filtered list
          answers empty to both. */}
      {d.oomKills !== null && d.oomKilled.length === 0 ? (
        <p className={cn(EMPTY, 'py-3 text-left')}>no container has ever been OOM-killed</p>
      ) : (
        <BarList items={d.oomKilled} tone="warn" empty="prometheus not answering" />
      )}
      <p className={FOOT}>
        Named, and only the killed: a fleet of zeros would bury the one counter that matters. This
        moving is what &ldquo;the cap is too tight&rdquo; looks like; a bar to the left resting on
        its limit is not. The kernel log below records which process was chosen and what it was
        holding.
      </p>

      <h4 className={SUB}>zram</h4>
      <Progress
        pct={
          d.zram.total === null || d.zram.used === null || d.zram.total === 0
            ? null
            : (d.zram.used / d.zram.total) * 100
        }
        tone={zramUsed > 0 ? 'warn' : 'muted'}
      />
      <Measures
        items={[
          { k: 'in use', v: bytes(d.zram.used) },
          { k: 'size', v: bytes(d.zram.total) },
        ]}
      />
      <p className={FOOT}>
        The only swap on this box, compressed in RAM with no disk behind it. Bytes in here are
        memory pressure that already happened and that no instantaneous gauge would show.
      </p>
    </Board>
  )
}

const CAP_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_6rem_minmax(6rem,12rem)_5rem]',
  '@max-[36rem]/table:grid-cols-[minmax(0,1fr)_6rem_5rem]',
)
const CAP_MID = '@max-[36rem]/table:hidden'
const N = 'text-right tabular-nums'

function CapsSection({ d }: { d: Memory }) {
  return (
    <TableSection title="Caps" aside={`${num(d.capped.length)} capped · ${num(d.uncapped)} not`}>
      <ul className={TABLE}>
        <li aria-hidden="true" className={cn(CAP_GRID, TABLE_HEAD)}>
          <span>Container</span>
          <span className={N}>In use</span>
          <span className={CAP_MID}>Of its cap</span>
          <span className={N}>Cap</span>
        </li>
        {d.capped.length === 0 && <li className={TABLE_EMPTY}>No container has a memory cap.</li>}
        {d.capped.map((c) => {
          const share =
            c.usageBytes === null || c.limitBytes === 0 ? null : (c.usageBytes / c.limitBytes) * 100
          // Near the cap is the row that differs; the rest stay grey.
          const tight = share !== null && share >= 85
          return (
            <li key={c.name} className={cn(CAP_GRID, TABLE_ROW)}>
              <span className={cn(CELL_MONO, 'text-[0.78rem] text-foreground')}>{c.name}</span>
              <span className={cn(N, tight ? 'text-warning' : CELL_QUIET)}>
                {bytes(c.usageBytes)}
              </span>
              <span className={cn(CAP_MID, 'flex items-center gap-2.5')}>
                <Progress pct={share} tone={tight ? 'warn' : 'muted'} height={4} />
                <span className={cn(CELL_QUIET, 'w-9 flex-none text-right')}>
                  {share === null ? DASH : `${share.toFixed(0)}%`}
                </span>
              </span>
              <span className={cn(N, 'text-foreground')}>{bytes(c.limitBytes)}</span>
            </li>
          )
        })}
      </ul>
      <p className={FOOT}>
        A cap is only enforced because systemd delegates <span className={MONO}>memory</span> to the
        rootless user slice — without that podman accepts the flag and the kernel ignores it. The
        module always emits <span className={MONO}>--memory-swap</span> equal to{' '}
        <span className={MONO}>--memory</span>: podman writes that value verbatim and defaults it to
        twice the limit, so a cap set alone would kill at three times what it says.{' '}
        {num(d.uncapped)} containers have no cap at all, which is the platform default. A
        silently-capped app is one that dies at 3am for a reason nobody wrote down.
      </p>
    </TableSection>
  )
}

function KernelBoard() {
  return (
    <LogBoard
      source={{ stack: 'kernel' }}
      title="Kernel"
      neighbours={HOST_READERS}
      foot={
        <p className={FOOT}>
          Kernel lines carry no unit and no container, so alloy labels them{' '}
          <span className={MONO}>stack=kernel</span>. This is the stream an OOM kill lands in. The
          counter on the panel above says one happened; this says which cgroup was chosen, how much
          it was holding, and what the machine was doing at the time. None of that survives in the
          killed container&rsquo;s own log.
        </p>
      }
    />
  )
}
