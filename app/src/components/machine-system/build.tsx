import { cn } from '../../lib/cn'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, num, pct, since } from '../../lib/format'
import { Board, BoardGrid, Facts, Measures } from '../viz'
import {
  ago,
  cpuName,
  EMPTY,
  FOOT,
  LIST,
  loadTone,
  MONO,
  NOTE,
  NotReadable,
  OS_MARK,
  PART,
  PART_DETAIL,
  PART_ID,
  PART_NAME,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  SUB,
  shortVendor,
  temp,
} from './shared'

/* ── Build ────────────────────────────────────────────────────────────── */

/**
 * The box's Build tab, for a node: the parts, as opposed to the layers.
 *
 * The box's page has two kinds of fact — read from SMBIOS, and written
 * down because nothing in a PC reports its case, cooler or supply. A node
 * has only the first kind: nobody is going to maintain a parts list for
 * every laptop that joins, so every board here is READ, and a part the
 * firmware does not describe is a dash with a reason, never a stock photo.
 * Cooling is the one board missing outright: neither OS reports a fan
 * without a vendor tool, and a board of "not connected" would be a lie
 * about a laptop that is plainly spinning one.
 */
export function NodeBuildView({ d }: { d: NodeSystemData }) {
  const { node, status } = d
  const t = d.telemetry
  if (t === null) return null
  const mk = t.machine
  const m = t.memory
  const first = m.modules[0]
  const soldered = m.slots === 0
  const mark = OS_MARK[node.os]
  const mac = node.os === 'macos'
  // Five read boards at a third each leave a hole; with one adapter the
  // graphics and power boards take a half each and the row closes.
  const half = t.gpus.length <= 1 ? 6 : 4

  return (
    <BoardGrid>
      <Board
        title={mac ? 'Logic board' : 'Motherboard'}
        icon="hash"
        span={4}
        aside={
          <span className={NOTE}>
            {mk.biosVersion === null
              ? 'no firmware reading'
              : `${mac ? 'firmware' : 'BIOS'} ${mk.biosVersion}`}
          </span>
        }
      >
        <div className={PART}>
          <div className={PART_ID}>
            <strong className={PART_NAME}>{mk.boardProduct ?? mk.model ?? DASH}</strong>
            <span className={PART_DETAIL}>
              {shortVendor(mk.boardManufacturer ?? mk.manufacturer)}
            </span>
          </div>
        </div>
        <Facts
          rows={[
            {
              k: mac ? 'Firmware' : 'BIOS',
              v: <span className={MONO}>{mk.biosVersion ?? DASH}</span>,
            },
            { k: 'Built', v: mk.biosDate ?? DASH },
            { k: 'Vendor', v: shortVendor(mk.biosVendor) },
            ...(mk.chip !== null ? [{ k: 'Chip', v: mk.chip }] : []),
          ]}
        />
        <p className={FOOT}>
          {mac
            ? 'Apple’s firmware moves with the OS, so a system update is a firmware update; the version here is what the last one left. There is nothing to compare it against, and the page does not try.'
            : 'Read from SMBIOS, so a BIOS update appears here on its own. Deliberately not compared against anything — no vendor publishes a machine-readable list of releases, and a version panel that quietly starts lying is worse than one that only states what is installed.'}
        </p>
      </Board>

      <Board
        title="Processor"
        icon="◈"
        span={4}
        aside={<span className={NOTE}>{temp(t.cpu.temperatureC)}</span>}
      >
        <div className={PART}>
          <div className={PART_ID}>
            <strong className={PART_NAME}>{cpuName(t.cpu.model ?? status?.cpu)}</strong>
            <span className={PART_DETAIL}>
              {t.cpu.cores === null || t.cpu.threads === null
                ? 'core count unread'
                : `${num(t.cpu.cores)} cores, ${num(t.cpu.threads)} threads`}
              {t.cpu.frequencyMhz !== null && ` · ${(t.cpu.frequencyMhz / 1000).toFixed(1)} GHz`}
            </span>
          </div>
        </div>
        <Measures
          items={[
            { k: 'package', v: temp(t.cpu.temperatureC) },
            { k: 'busy', v: pct(t.cpu.usagePct, 1) },
            {
              k: 'clock',
              v: t.cpu.frequencyMhz === null ? DASH : `${num(t.cpu.frequencyMhz)} MHz`,
            },
            { k: 'arch', v: status?.arch ?? DASH },
          ]}
        />
        <p className={FOOT}>
          {mac
            ? 'Performance and efficiency cores counted together; Apple states the split nowhere the agent can read. The clock is nominal — the chip does not publish what it is running at.'
            : 'Cores are physical and threads are what the scheduler sees; the clock is the base frequency the firmware states, not the boost it reaches under load.'}
        </p>
      </Board>

      <Board
        title="Memory"
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
            { k: 'Installed', v: bytes(m.totalBytes) },
            { k: 'Type', v: first?.kind ?? DASH },
            { k: 'Speed', v: first?.speedMts == null ? DASH : `${num(first.speedMts)} MT/s` },
            { k: 'Maker', v: first?.manufacturer ?? DASH },
            { k: 'Part', v: <span className={MONO}>{first?.partNumber ?? DASH}</span> },
            {
              k: 'Ceiling',
              v: soldered ? 'as bought' : bytes(m.maxCapacityBytes),
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
                  <span className={ROW_SIDE}>{x.kind ?? DASH}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Board>

      {t.gpus.length === 0 ? (
        <Board title="Graphics" icon="◐" span={half}>
          <p className={EMPTY}>
            {t.errors.find((e) => /gpu|graphics|display/i.test(e)) ??
              'No graphics adapter reported.'}
          </p>
        </Board>
      ) : (
        t.gpus.map((g, i) => (
          <Board
            key={`${g.name}-${String(i)}`}
            title={t.gpus.length === 1 ? 'Graphics' : `Graphics ${String(i + 1)}`}
            icon="◐"
            span={half}
            aside={g.vendor !== null ? <span className={NOTE}>{g.vendor}</span> : undefined}
          >
            <div className={PART}>
              <div className={PART_ID}>
                <strong className={PART_NAME}>{g.name}</strong>
                <span className={PART_DETAIL}>
                  {g.vramTotalBytes === null
                    ? soldered
                      ? 'shares the unified memory'
                      : 'memory unread'
                    : `${bytes(g.vramTotalBytes)} of its own`}
                  {g.driver !== null && ` · driver ${g.driver}`}
                </span>
              </div>
            </div>
            <Measures
              items={[
                { k: 'busy', v: pct(g.usagePct), tone: loadTone(g.usagePct) },
                { k: 'memory', v: bytes(g.vramUsedBytes) },
                { k: 'temp', v: temp(g.temperatureC) },
                { k: 'power', v: g.powerW === null ? DASH : `${g.powerW.toFixed(1)} W` },
              ]}
            />
            <p className={FOOT}>
              {mac
                ? 'Device utilisation as the accelerator driver counts it. Power and temperature come from powermetrics, which on this chip does not answer inside the agent’s deadline — see the last board.'
                : 'The 3D engine’s utilisation and the dedicated memory in use, from the same counters Task Manager draws. Temperature and power need the vendor’s own tool, which the agent does not carry.'}
            </p>
          </Board>
        ))
      )}

      <Board
        title="Power"
        icon="⚡"
        span={half}
        aside={
          t.battery === null ? (
            <span className={NOTE}>mains</span>
          ) : (
            <span className={NOTE}>
              {t.battery.charging === null ? '' : t.battery.charging ? 'charging' : 'on battery'}
            </span>
          )
        }
      >
        {t.battery === null ? (
          <>
            <p className={EMPTY}>No battery: this machine runs off the wall.</p>
            <p className={FOOT}>
              Nothing about the supply is readable from software on a desktop — the same gap the box
              has, which is why its Power board is written down rather than read.
            </p>
          </>
        ) : (
          <>
            <Measures
              items={[
                { k: 'charge', v: pct(t.battery.percent) },
                { k: 'health', v: pct(t.battery.healthPct) },
                {
                  k: 'source',
                  v:
                    t.battery.charging === null ? DASH : t.battery.charging ? 'adapter' : 'battery',
                },
              ]}
            />
            <p className={FOOT}>
              Health is the capacity that remains against the design capacity, which is the number
              that decides when the battery is replaced; a charge that empties fast on a healthy
              battery is the software, not the cell.
            </p>
          </>
        )}
      </Board>

      <Board title="The machine" icon="▣" span={12}>
        <div
          className={cn(
            PART,
            'items-start gap-[1.4rem]',
            '@max-[30rem]/board:flex-col @max-[30rem]/board:items-center',
          )}
        >
          {mark !== undefined && (
            <img
              src={mark.src}
              alt=""
              width={96}
              height={96}
              className={cn(
                'block size-[clamp(64px,14%,96px)] flex-none object-contain',
                mark.invert && 'dark:invert',
              )}
            />
          )}
          <div className={PART_ID}>
            <strong className={PART_NAME}>{mk.model ?? node.name}</strong>
            <span className={PART_DETAIL}>
              {[shortVendor(mk.manufacturer), mk.form].filter((x) => x !== DASH && x).join(' · ') ||
                'make unread'}
            </span>
            <div className="mt-2 w-full">
              <Facts
                rows={[
                  {
                    k: 'System',
                    v: `${status?.osName ?? node.os}${status?.osVersion ? ` ${status.osVersion}` : ''}`,
                  },
                  { k: 'Kernel', v: <span className={MONO}>{t.os.kernel ?? DASH}</span> },
                  ...(t.os.build
                    ? [{ k: 'Build', v: <span className={MONO}>{t.os.build}</span> }]
                    : []),
                  { k: 'Installed', v: ago(t.os.installedAt) },
                  { k: 'Hardware address', v: <span className={MONO}>{node.mac ?? DASH}</span> },
                  {
                    k: 'Agent',
                    v: `${status?.version ?? node.agentVersion} · approved ${node.approvedAt === null ? DASH : since((Date.now() - Date.parse(node.approvedAt)) / 1000)}`,
                  },
                ]}
              />
            </div>
          </div>
        </div>
        <p className={FOOT}>
          {mac
            ? 'Model and chip from system_profiler, which is what About This Mac reads. Apple’s model names carry the year, which is the fact a spare part is bought against.'
            : 'Manufacturer, model and chassis from SMBIOS, which is what the firmware was told at the factory: a home-built machine reports its board vendor here and “desktop” or nothing for its shape.'}
        </p>
      </Board>

      <NotReadable t={t} />
    </BoardGrid>
  )
}
