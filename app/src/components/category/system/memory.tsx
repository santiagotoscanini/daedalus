import type { SystemData } from '../../../lib/dashboard/categories/system'
import { bytes, DASH, num, pct } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Progress } from '../../viz'
import { HOST_READERS, PARTS, PartHead } from './shared'

/* ── Memory ───────────────────────────────────────────────────────────── */

type Memory = Extract<SystemData, { tab: 'memory' }>

export function MemoryView({ d }: { d: Memory }) {
  const arcShare = d.arc.size === null || d.total === null ? null : (d.arc.size / d.total) * 100

  return (
    <BoardGrid>
      <Board
        title="Memory"
        icon="rows"
        span={8}
        aside={<span className="board-note">{bytes(d.total)} total</span>}
      >
        <Progress
          pct={d.total === null || d.used === null ? null : (d.used / d.total) * 100}
          tone="info"
        />
        <Measures
          items={[
            { k: 'used', v: bytes(d.used) },
            { k: 'available', v: bytes(d.available) },
            { k: 'page cache', v: bytes(d.cached) },
            { k: 'dirty', v: bytes(d.dirty) },
          ]}
        />
        <p className="board-foot">
          Read <b>available</b>, not used. Linux spends free memory on cache by design, so a box
          with nothing to do still reports most of its memory in use — and on this one a large share
          of that is ZFS&rsquo;s cache, which is charged to the kernel and handed back on demand.
        </p>
      </Board>

      {/* The sticks behind the bar above. Every other number on this tab is
          bytes in flight; this is what they are flying through, and it is the
          only panel here that answers "can I add more" — which is the question
          a memory page gets asked when the bar looks full. */}
      <Board
        title="The modules"
        icon="rows"
        span={4}
        aside={
          <span className="board-note">
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
              v: <span className="mono">{d.modules.modules[0]?.partNumber ?? DASH}</span>,
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
        <p className="board-foot">
          Read from SMBIOS rather than counted from bytes — the kernel knows how much memory it has
          and nothing about how it arrives. Two slots free against a 128 GB ceiling is the headroom
          this machine actually has, and the full specification is on <b>Build</b>.
        </p>
      </Board>

      <Board title="ZFS cache" icon="◍" span={4}>
        <Progress
          pct={d.arc.size === null || d.arc.max === null ? null : (d.arc.size / d.arc.max) * 100}
          tone="accent"
        />
        <Facts
          rows={[
            { k: 'ARC now', v: bytes(d.arc.size) },
            { k: 'Ceiling', v: bytes(d.arc.max) },
            { k: 'Share of RAM', v: pct(arcShare) },
            { k: 'Hit rate (30m)', v: pct(d.arc.hitRate, 1) },
          ]}
        />
        <p className="board-foot">
          {/* The panel that makes the one to its left readable. */}
          The single biggest consumer on this box and the reason &ldquo;used&rdquo; looks alarming.
          ARC grows to fill what nothing else wants and shrinks under pressure — a high hit rate
          here is what keeps the pools from being asked.
        </p>
      </Board>

      <Board title="zram" icon="⇵" span={4}>
        <Progress
          pct={
            d.zram.total === null || d.zram.used === null || d.zram.total === 0
              ? null
              : (d.zram.used / d.zram.total) * 100
          }
          tone={(d.zram.used ?? 0) > 0 ? 'warn' : 'ok'}
        />
        <Measures
          items={[
            { k: 'in use', v: bytes(d.zram.used) },
            { k: 'size', v: bytes(d.zram.total) },
          ]}
        />
        <p className="board-foot">
          The only swap on this box — compressed, in RAM, no disk. Bytes in here are memory pressure
          that already happened and that no instantaneous gauge would show.
        </p>
      </Board>

      <Board title="Heaviest containers" icon="grid" span={8}>
        <BarList items={d.topMemory} tone="info" empty="nothing reporting" />
        <p className="board-foot">
          This is <span className="mono">memory.current</span>, which <b>includes page cache</b>. A
          container doing file I/O sits near its limit forever and is perfectly healthy; the cache
          is reclaimed when something else needs it. The number that means a cap is genuinely too
          tight is the OOM board beside this one, not this bar.
        </p>
      </Board>

      <Board
        title="OOM kills"
        icon="warn"
        span={4}
        aside={
          d.oomKills === null ? (
            <span className="board-note">{DASH}</span>
          ) : d.oomKills > 0 ? (
            <span className="board-note">{num(d.oomKills)} all time</span>
          ) : (
            <Chip tone="ok">none, ever</Chip>
          )
        }
      >
        {/* The total tells "never" from "unreachable" — the filtered list
            answers empty to both. */}
        {d.oomKills !== null && d.oomKilled.length === 0 ? (
          <p className="viz-empty">no container has ever been OOM-killed</p>
        ) : (
          <BarList items={d.oomKilled} tone="warn" empty="prometheus not answering" />
        )}
        <p className="board-foot">
          Named, and only the killed — a fleet of zeros would bury the one counter that matters.
          This moving is what &ldquo;the cap is too tight&rdquo; actually looks like; a bar to the
          left resting on its limit is not. The kernel log below records which process was chosen
          and what it was holding.
        </p>
      </Board>

      <Board
        title="Caps"
        icon="⊟"
        span={12}
        aside={
          <span className="board-note">
            {num(d.capped.length)} capped · {num(d.uncapped)} not
          </span>
        }
      >
        {d.capped.length === 0 ? (
          <p className="viz-empty">No container has a memory cap.</p>
        ) : (
          <ul className="itemlist">
            {d.capped.map((c) => (
              <li key={c.name}>
                <span className="item-main mono">{c.name}</span>
                <span className="item-side">{bytes(c.usageBytes)} in use</span>
                <span className="item-n">{bytes(c.limitBytes)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="board-foot">
          A cap is only enforced because systemd delegates <span className="mono">memory</span> to
          the rootless user slice — without that podman accepts the flag and the kernel ignores it.
          The module always emits <span className="mono">--memory-swap</span> equal to{' '}
          <span className="mono">--memory</span>: podman writes that value verbatim and defaults it
          to twice the limit, so a cap set alone would kill at three times what it says.{' '}
          {num(d.uncapped)} containers have no cap at all, which is the platform default — a
          silently-capped app is one that dies at 3am for a reason nobody wrote down.
        </p>
      </Board>

      {/* This was the one tab in the whole dashboard with no log at all, which
          made it the one page whose numbers could not be checked against
          anything. The kernel is the right stream: an OOM kill, a zram
          allocation failure and ZFS shrinking the ARC under pressure are all
          kernel lines and appear in no container's log — including the log of
          the container that was killed. */}
      <LogBoard
        source={{ stack: 'kernel' }}
        title="Kernel"
        neighbours={HOST_READERS}
        foot={
          <p className="board-foot">
            Kernel lines carry no unit and no container, so alloy labels them{' '}
            <span className="mono">stack=kernel</span> — this is the stream an OOM kill actually
            lands in. The counter on the panel above says one happened; this says which cgroup was
            chosen, how much it was holding, and what the machine was doing at the time, none of
            which survives in the killed container&rsquo;s own log.
          </p>
        }
      />
    </BoardGrid>
  )
}
