import { BarList, Board, BoardGrid, Facts, Measures, Progress } from '../../../../components/viz'
import type { NodeSystemData } from '../../../../lib/dashboard/node-system'
import { bytes, DASH, num } from '../../../../lib/format'
import {
  EMPTY,
  FOOT,
  LIST,
  loadTone,
  MONO,
  NOTE,
  NotReadable,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  SUB,
  share,
} from './shared'

/* ── Memory ───────────────────────────────────────────────────────────── */

/**
 * The box's Memory tab, for a node: the bar, the sticks behind it, where
 * the overflow goes, and who is holding the most.
 *
 * The box's page is half about ZFS and cgroups — the ARC, zram, the caps,
 * the OOM kills — none of which a desktop has. What it has instead is a
 * compressor (both OSes keep cold pages compressed in RAM before touching
 * a disk) and, on Windows, a commit charge, which is the number that
 * actually decides whether an allocation fails. Those take the boards the
 * ZFS ones held.
 */
export function NodeMemoryView({ d }: { d: NodeSystemData }) {
  const f = nodeMemoryFacts({ d })
  if (f === null) return null
  const { t } = f

  return (
    <BoardGrid>
      <MemoryBoard f={f} />

      <TheModulesBoard f={f} />

      <Panel f={f} />

      <HeaviestProcessesBoard f={f} />

      <NotReadable t={t} />
    </BoardGrid>
  )
}

/** What the page's boards read. */
function nodeMemoryFacts({ d }: { d: NodeSystemData }) {
  const { node } = d
  const t = d.telemetry
  if (t === null) return null
  const m = t.memory
  const heaviest = [...t.processes]
    .filter((p) => p.memory_bytes !== null)
    .sort((a, b) => (b.memory_bytes ?? 0) - (a.memory_bytes ?? 0))
    .slice(0, 10)
  const first = m.modules[0]
  const soldered = m.slots === 0
  const usedPct = share(m.used_bytes, m.total_bytes)
  return { d, node, t, m, heaviest, first, soldered, usedPct }
}

type NodeMemoryFacts = NonNullable<ReturnType<typeof nodeMemoryFacts>>

function MemoryBoard({ f }: { f: NodeMemoryFacts }) {
  const { node, m, usedPct } = f
  return (
    <Board
      title="Memory"
      icon="rows"
      span={8}
      aside={<span className={NOTE}>{bytes(m.total_bytes)} total</span>}
    >
      <Progress pct={usedPct} tone={loadTone(usedPct)} />
      <Measures
        items={[
          { k: 'used', v: bytes(m.used_bytes) },
          { k: 'available', v: bytes(m.available_bytes) },
          { k: 'file cache', v: bytes(m.cached_bytes) },
          { k: 'compressed', v: bytes(m.compressed_bytes) },
        ]}
      />
      <p className={FOOT}>
        Read <b>available</b>, not used: both systems spend free memory on cache and hand it back on
        demand.{' '}
        {node.os === 'macos'
          ? 'macOS goes further and compresses cold pages in place before it swaps — the compressed figure is memory pressure that has already happened, and a large one is the machine telling you it would like more.'
          : 'The file cache is the standby list, which Windows counts as available; the compressed figure is the Memory Compression store, which it does not.'}
      </p>
    </Board>
  )
}

function TheModulesBoard({ f }: { f: NodeMemoryFacts }) {
  const { m, first, soldered } = f
  return (
    <Board
      title="The modules"
      icon="rows"
      span={4}
      aside={
        <span className={NOTE}>
          {m.slots === null
            ? DASH
            : soldered
              ? 'on the package'
              : `${num(m.modules.length)} of ${num(m.slots)} slots`}
        </span>
      }
    >
      <Facts
        rows={[
          {
            k: 'Installed',
            v:
              m.total_bytes === null ? DASH : `${bytes(m.total_bytes)} ${first?.kind ?? ''}`.trim(),
          },
          {
            k: 'Speed',
            v: first?.speed_mts == null ? DASH : `${num(first.speed_mts)} MT/s`,
          },
          {
            k: 'Part',
            v: <span className={MONO}>{first?.part_number ?? first?.manufacturer ?? DASH}</span>,
          },
          {
            k: 'Room left',
            v: soldered
              ? 'none: soldered'
              : m.max_capacity_bytes === null || m.total_bytes === null || m.slots === null
                ? DASH
                : `${bytes(m.max_capacity_bytes - m.total_bytes)} in ${num(m.slots - m.modules.length)} slots`,
          },
        ]}
      />
      {m.modules.length > 1 && (
        <>
          <h4 className={SUB}>Slots</h4>
          <ul className={LIST}>
            {m.modules.map((x, i) => (
              <li key={`${x.locator ?? '?'}-${String(i)}`} className={ROW}>
                <span className={ROW_MAIN}>{x.locator ?? `#${String(i + 1)}`}</span>
                <span className={ROW_SIDE}>{bytes(x.size_bytes)}</span>
                <span className={ROW_SIDE}>
                  {x.speed_mts === null ? DASH : `${num(x.speed_mts)} MT/s`}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className={FOOT}>
        {soldered
          ? 'Unified memory on the package, which is why the GPU on Build has no VRAM of its own: it shares this. The amount was decided at purchase and cannot change.'
          : m.slots === null
            ? 'The firmware did not describe its slots; the agent reads them from SMBIOS and this one answered nothing.'
            : 'Read from the firmware rather than counted from bytes, so an empty slot is a slot the board has, not a guess. The full specification is on Build.'}
      </p>
    </Board>
  )
}

function Panel({ f }: { f: NodeMemoryFacts }) {
  const { node, m } = f
  return (
    <Board title={node.os === 'windows' ? 'Commit' : 'Swap'} icon="⇵" span={4}>
      {node.os === 'windows' ? (
        <>
          <Progress
            pct={share(m.committed_bytes, m.commit_limit_bytes)}
            tone={loadTone(share(m.committed_bytes, m.commit_limit_bytes))}
          />
          <Measures
            items={[
              { k: 'charge', v: bytes(m.committed_bytes) },
              { k: 'limit', v: bytes(m.commit_limit_bytes) },
              { k: 'pagefile', v: bytes(m.swap_total_bytes) },
            ]}
          />
          <p className={FOOT}>
            The commit charge is every private page a process has been promised, and the limit is
            RAM plus the pagefile. An allocation fails against the limit, not against free memory,
            which is why a machine with memory to spare can still tell an application it has none.
            How much of the pagefile is actually in use, Windows does not say.
          </p>
        </>
      ) : (
        <>
          <Progress
            pct={share(m.swap_used_bytes, m.swap_total_bytes)}
            tone={(m.swap_used_bytes ?? 0) > 0 ? 'warn' : 'ok'}
          />
          <Measures
            items={[
              { k: 'in use', v: bytes(m.swap_used_bytes) },
              { k: 'size', v: bytes(m.swap_total_bytes) },
            ]}
          />
          <p className={FOOT}>
            The swap file on the boot volume, grown on demand and shrunk back when idle. Bytes here
            are what the compressor could not hold; a machine that swaps steadily is short of memory
            it cannot be given.
          </p>
        </>
      )}
    </Board>
  )
}

function HeaviestProcessesBoard({ f }: { f: NodeMemoryFacts }) {
  const { t, heaviest } = f
  return (
    <Board title="Heaviest processes" icon="grid" span={8}>
      {t.processes.length === 0 ? (
        <p className={EMPTY}>nothing reporting</p>
      ) : (
        <BarList
          items={heaviest.map((p) => ({
            label: p.name,
            value: p.memory_bytes ?? 0,
            display: bytes(p.memory_bytes),
          }))}
          tone="info"
          empty="nothing reporting"
        />
      )}
      <p className={FOOT}>
        Resident memory — the working set on Windows, RSS on a Mac — which counts shared libraries
        against every process that maps them, so the bars add up to more than the bar above. The
        twelve heaviest of {num(t.process_count)}. The busiest by processor are on <b>Host</b>.
      </p>
    </Board>
  )
}
