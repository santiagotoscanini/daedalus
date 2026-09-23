import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, num } from '../../lib/format'
import { BarList, Board, BoardGrid, Facts, Measures, Progress } from '../viz'
import {
  DetailNote,
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
  const { node } = d
  const t = d.telemetry
  if (t === null) return null
  const m = t.memory
  const heaviest = [...t.processes]
    .filter((p) => p.memoryBytes !== null)
    .sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0))
    .slice(0, 10)
  const first = m.modules[0]
  const soldered = m.slots === 0
  const usedPct = share(m.usedBytes, m.totalBytes)

  return (
    <BoardGrid>
      <Board
        title="Memory"
        icon="rows"
        span={8}
        aside={<span className={NOTE}>{bytes(m.totalBytes)} total</span>}
      >
        <Progress pct={usedPct} tone={loadTone(usedPct)} />
        <Measures
          items={[
            { k: 'used', v: bytes(m.usedBytes) },
            { k: 'available', v: bytes(m.availableBytes) },
            { k: 'file cache', v: bytes(m.cachedBytes) },
            { k: 'compressed', v: bytes(m.compressedBytes) },
          ]}
        />
        <p className={FOOT}>
          Read <b>available</b>, not used: both systems spend free memory on cache and hand it back
          on demand.{' '}
          {node.os === 'macos'
            ? 'macOS goes further and compresses cold pages in place before it swaps — the compressed figure is memory pressure that has already happened, and a large one is the machine telling you it would like more.'
            : 'The file cache is the standby list, which Windows counts as available; the compressed figure is the Memory Compression store, which it does not.'}
        </p>
      </Board>

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
                m.totalBytes === null ? DASH : `${bytes(m.totalBytes)} ${first?.kind ?? ''}`.trim(),
            },
            {
              k: 'Speed',
              v: first?.speedMts == null ? DASH : `${num(first.speedMts)} MT/s`,
            },
            {
              k: 'Part',
              v: <span className={MONO}>{first?.partNumber ?? first?.manufacturer ?? DASH}</span>,
            },
            {
              k: 'Room left',
              v: soldered
                ? 'none: soldered'
                : m.maxCapacityBytes === null || m.totalBytes === null || m.slots === null
                  ? DASH
                  : `${bytes(m.maxCapacityBytes - m.totalBytes)} in ${num(m.slots - m.modules.length)} slots`,
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
                  <span className={ROW_SIDE}>{bytes(x.sizeBytes)}</span>
                  <span className={ROW_SIDE}>
                    {x.speedMts === null ? DASH : `${num(x.speedMts)} MT/s`}
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

      <Board title={node.os === 'windows' ? 'Commit' : 'Swap'} icon="⇵" span={4}>
        {node.os === 'windows' ? (
          <>
            <Progress
              pct={share(m.committedBytes, m.commitLimitBytes)}
              tone={loadTone(share(m.committedBytes, m.commitLimitBytes))}
            />
            <Measures
              items={[
                { k: 'charge', v: bytes(m.committedBytes) },
                { k: 'limit', v: bytes(m.commitLimitBytes) },
                { k: 'pagefile', v: bytes(m.swapTotalBytes) },
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
              pct={share(m.swapUsedBytes, m.swapTotalBytes)}
              tone={(m.swapUsedBytes ?? 0) > 0 ? 'warn' : 'ok'}
            />
            <Measures
              items={[
                { k: 'in use', v: bytes(m.swapUsedBytes) },
                { k: 'size', v: bytes(m.swapTotalBytes) },
              ]}
            />
            <p className={FOOT}>
              The swap file on the boot volume, grown on demand and shrunk back when idle. Bytes
              here are what the compressor could not hold; a machine that swaps steadily is short of
              memory it cannot be given.
            </p>
          </>
        )}
      </Board>

      <Board title="Heaviest processes" icon="grid" span={8}>
        {t.processes.length === 0 ? (
          <p className={EMPTY}>{d.full ? 'nothing reporting' : 'on the full document'}</p>
        ) : (
          <BarList
            items={heaviest.map((p) => ({
              label: p.name,
              value: p.memoryBytes ?? 0,
              display: bytes(p.memoryBytes),
            }))}
            tone="info"
            empty="nothing reporting"
          />
        )}
        <DetailNote d={d} />
        <p className={FOOT}>
          Resident memory — the working set on Windows, RSS on a Mac — which counts shared libraries
          against every process that maps them, so the bars add up to more than the bar above. The
          twelve heaviest of {num(t.processCount)}. The busiest by processor are on <b>Host</b>.
        </p>
      </Board>

      <NotReadable t={t} />
    </BoardGrid>
  )
}
