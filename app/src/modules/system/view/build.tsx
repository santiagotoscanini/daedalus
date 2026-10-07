import { LogBoard } from '../../../components/logs'
import {
  PART,
  PART_DETAIL,
  PART_ID,
  PART_NAME,
  PART_WIDE,
  PartHead,
  PartPhoto,
} from '../../../components/part'
import {
  CAPTION,
  EMPTY,
  FOOT,
  LIST,
  MONO,
  MONO_FACE,
  NOTE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  SUB,
} from '../../../components/tokens'
import { BarList, Board, BoardGrid, Facts, Measures } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { cpuName, DASH, num, pct, shortVendor, temp } from '../../../lib/format'
import { partMatching } from '../../../lib/hardware/catalog'
import type { SystemData } from '../data'
import { HOST_READERS, PARTS } from './shared'

/* ── Build ────────────────────────────────────────────────────────────── */

type Build = Extract<SystemData, { tab: 'build' }>

export function BuildView({ d }: { d: Build }) {
  const f = buildFacts({ d })

  return (
    <BoardGrid>
      {/* Rows of peers with related heights: the three compact parts, then
          the two with lists (the board's sensors, the memory slots), then
          the power supply beside the case it fits. */}
      <ProcessorBoard f={f} />

      <CoolingBoard f={f} />

      <GraphicsBoard f={f} />

      <MotherboardBoard f={f} />

      <MemoryBoard f={f} />

      <PowerBoard f={f} />

      <TheCaseBoard />

      {/* The snapshot behind the declared-vs-read split: every fact on this
          page that was READ came through this unit or through node-exporter,
          and a stale snapshot shows last week's inventory as though it were
          now. Same neighbour as Disks and Pools, for the same reason. */}
      <LogBoard
        source={{ unit: 'daedalus-system-snapshot.service' }}
        title="System snapshot"
        neighbours={HOST_READERS}
      />
    </BoardGrid>
  )
}

/** What the page's boards read. */
function buildFacts({ d }: { d: Build }) {
  const hw = d.hardware
  const spinning = d.fans.filter((f) => f.rpm > 0)
  const board = hw.board
  const cpuPart = partMatching('cpu', hw.cpu.model)
  return { d, hw, spinning, board, cpuPart }
}

type BuildFacts = NonNullable<ReturnType<typeof buildFacts>>

function MotherboardBoard({ f }: { f: BuildFacts }) {
  const { d, board } = f
  return (
    <Board
      title="Motherboard"
      icon="hash"
      span={6}
      aside={
        <span className={NOTE}>
          {board.bios.version === null ? 'no BIOS reading' : `BIOS ${board.bios.version}`}
        </span>
      }
    >
      <div className={PART}>
        <div className={PART_ID}>
          <strong className={PART_NAME}>{board.model ?? DASH}</strong>
          <span className={PART_DETAIL}>
            {board.vendor === null ? 'unknown vendor' : shortVendor(board.vendor)}
            {board.version !== null && ` · board rev ${board.version}`}
          </span>
        </div>
      </div>
      <Facts
        rows={[
          { k: 'BIOS', v: <span className={MONO}>{board.bios.version ?? DASH}</span> },
          { k: 'Built', v: board.bios.date ?? DASH },
          {
            k: 'BIOS vendor',
            v: board.bios.vendor === null ? DASH : shortVendor(board.bios.vendor),
          },
        ]}
      />
      {/* The board's own sensors, on the board they are soldered to — the
          chipset (PCH) and VRM readings included, so they are said once. */}
      <h4 className={SUB}>Board temperatures</h4>
      <BarList
        items={d.temps.map((t) => ({
          label: t.label,
          value: t.value,
          display: `${t.value.toFixed(0)}°`,
        }))}
        tone="muted"
        empty="no board sensors"
      />
      <p className={FOOT}>
        Read from SMBIOS, so a BIOS update appears here on its own. It is deliberately not compared
        against anything: MSI publishes no machine-readable list of releases, and the only way to
        claim &ldquo;two behind&rdquo; would be to scrape a vendor page that will change shape
        without warning. A version panel that quietly starts lying is worse than one that only ever
        states what is installed.
      </p>
    </Board>
  )
}

function ProcessorBoard({ f }: { f: BuildFacts }) {
  const { d, hw, cpuPart } = f
  return (
    <Board
      title="Processor"
      icon="◈"
      span={4}
      aside={<span className={NOTE}>{temp(d.cpu.tempC)}</span>}
    >
      <div className={PART}>
        {cpuPart !== null && <PartPhoto part={cpuPart} />}
        <div className={PART_ID}>
          <strong className={PART_NAME}>{cpuName(hw.cpu.model)}</strong>
          <span className={PART_DETAIL}>
            {hw.cpu.cores === null || hw.cpu.threads === null
              ? 'core count unread'
              : `${num(hw.cpu.cores)} cores, ${num(hw.cpu.threads)} threads`}
            {hw.cpu.maxMhz !== null && ` · up to ${(hw.cpu.maxMhz / 1000).toFixed(1)} GHz`}
          </span>
        </div>
      </div>
      <Measures
        items={[
          { k: 'package', v: temp(d.cpu.tempC) },
          { k: 'busy', v: pct(d.cpu.usagePct, 1) },
          {
            k: 'clock',
            v: d.cpu.frequencyMhz === null ? DASH : `${num(Math.round(d.cpu.frequencyMhz))} MHz`,
          },
          { k: 'socket', v: hw.cpu.socket ?? DASH },
        ]}
      />
      <p className={FOOT}>
        Ten cores and sixteen threads is not an error: six of them are efficiency cores with no
        hyperthread. That asymmetry is why the per-core temperature list on Host is uneven. The two
        kinds of core do not run at the same clock and are not meant to.
      </p>
    </Board>
  )
}

function CoolingBoard({ f }: { f: BuildFacts }) {
  const { d, spinning } = f
  return (
    <Board
      title="Cooling"
      icon="❋"
      span={4}
      aside={
        <span className={NOTE}>
          {spinning.length === 0
            ? 'nothing spinning'
            : `${num(spinning.length)} of ${num(d.fans.length)} headers`}
        </span>
      }
    >
      <PartHead part={PARTS.cooler} />
      <h4 className={SUB}>Fan headers</h4>
      {/* The spinning headers are rows; the empty ones are one line. Seven
          rows of "not connected" were most of the board and said one thing. */}
      <ul className={LIST}>
        {d.fans
          .filter((f) => f.rpm > 0)
          .map((f) => (
            <li key={f.label} className={ROW}>
              <span className={ROW_MAIN}>{f.label}</span>
              <span className={ROW_SIDE}>
                <span className={MONO}>{num(f.rpm)} rpm</span>
              </span>
            </li>
          ))}
        {d.fans.length === 0 && <p className={EMPTY}>no fan sensors; see the note below</p>}
      </ul>
      {d.fans.some((f) => f.rpm <= 0) && (
        <p className={CAPTION}>
          Not connected:{' '}
          {d.fans
            .filter((f) => f.rpm <= 0)
            .map((f) => f.label)
            .join(', ')}
          .
        </p>
      )}
      <p className={FOOT}>
        These readings exist because a driver was added for the board&rsquo;s Nuvoton super-I/O
        chip; without it Linux sees three sensors and counts no revolutions at all, which on a
        machine that lives in a cupboard makes a dead fan silent until it is thermal. Headers
        reading zero are empty, not faulty.
      </p>
    </Board>
  )
}

function MemoryBoard({ f }: { f: BuildFacts }) {
  const { hw } = f
  return (
    <Board
      title="Memory"
      icon="rows"
      span={6}
      aside={
        <span className={NOTE}>
          {hw.memory.populated === null || hw.memory.slots === null
            ? DASH
            : `${num(hw.memory.populated)} of ${num(hw.memory.slots)} slots`}
        </span>
      }
    >
      <PartHead part={PARTS.memory} />
      <Facts
        rows={[
          {
            k: 'Installed',
            v: hw.memory.totalGb === null ? DASH : `${num(hw.memory.totalGb)} GB`,
          },
          { k: 'Type', v: hw.memory.modules[0]?.type ?? DASH },
          {
            k: 'Speed',
            v:
              hw.memory.modules[0]?.speedMts == null
                ? DASH
                : `${num(hw.memory.modules[0].speedMts)} MT/s`,
          },
          {
            k: 'Part',
            v: <span className={MONO}>{hw.memory.modules[0]?.partNumber ?? DASH}</span>,
          },
          {
            k: 'Room left',
            v:
              hw.memory.maxCapacityGb === null || hw.memory.totalGb === null
                ? DASH
                : `${num(hw.memory.maxCapacityGb - hw.memory.totalGb)} GB`,
          },
        ]}
      />
      <h4 className={SUB}>Slots</h4>
      <ul className={LIST}>
        {hw.memory.modules.map((m) => (
          <li key={m.locator ?? '?'} className={ROW}>
            <span className={ROW_MAIN}>{(m.locator ?? '?').replace('Controller', 'Ch ')}</span>
            <span className={ROW_SIDE}>{m.sizeGb === null ? DASH : `${num(m.sizeGb)} GB`}</span>
            <span className={ROW_SIDE}>{m.rank === null ? DASH : `${num(m.rank)}R`}</span>
          </li>
        ))}
        {hw.memory.modules.length === 0 && <p className={EMPTY}>no modules read</p>}
      </ul>
      <p className={FOOT}>
        Both modules sit in the second slot of each channel, which is the pairing the board wants
        for dual channel. The empty slots are the two that would break it if filled wrong. Two free
        slots and a 128 GB ceiling is the upgrade this machine has left.
      </p>
    </Board>
  )
}

function GraphicsBoard({ f }: { f: BuildFacts }) {
  const { d } = f
  return (
    <Board
      title="Graphics"
      icon="◐"
      span={4}
      aside={
        <span className={NOTE}>
          {d.gpu.clients === null ? DASH : `${num(d.gpu.clients)} clients`}
        </span>
      }
    >
      <div className={PART}>
        <div className={PART_ID}>
          <strong className={PART_NAME}>Intel UHD Graphics 770</strong>
          <span className={PART_DETAIL}>
            Integrated in the CPU; there is no card in this machine. It transcodes for Jellyfin and
            runs Immich&rsquo;s vision models.
          </span>
        </div>
      </div>
      <Measures
        items={[
          {
            k: 'power',
            v: d.gpu.powerWatts === null ? DASH : `${d.gpu.powerWatts.toFixed(1)} W`,
          },
          {
            k: 'clock',
            v: d.gpu.frequencyMhz === null ? DASH : `${num(Math.round(d.gpu.frequencyMhz))} MHz`,
          },
          { k: 'busiest', v: d.gpu.busiestEngine?.name ?? DASH },
          {
            k: 'package',
            v: d.gpu.packageWatts === null ? DASH : `${d.gpu.packageWatts.toFixed(1)} W`,
          },
        ]}
      />
      <p className={FOOT}>
        A parked graphics engine reads zero watts and zero megahertz. That is the honest number
        rather than a broken one: it wakes when something asks it to. The package figure beside it
        is the whole chip including the cpu cores, which is why the two are shown together — on an
        integrated part they are one piece of silicon and one power budget. The render node is
        passed into three containers at once: jellyfin for QSV transcoding, immich for OpenVINO, and
        the exporter these numbers come from.
      </p>
    </Board>
  )
}

function PowerBoard({ f }: { f: BuildFacts }) {
  const { d } = f
  return (
    <Board
      title="Power"
      icon="⚡"
      span={4}
      aside={<span className={NOTE}>{PARTS.psu.specs[0]?.v ?? DASH}</span>}
    >
      <PartHead part={PARTS.psu} />
      <h4 className={SUB}>Rails, as the board sees them</h4>
      <ul className={LIST}>
        {['+12V', '+5V', '+3.3V'].map((rail) => {
          const v = d.volts.find((x) => x.label === rail)
          return (
            <li key={rail} className={ROW}>
              <span className={ROW_MAIN}>{rail}</span>
              <span className={cn(ROW_SIDE, MONO_FACE)}>
                {v === undefined ? DASH : `${v.value.toFixed(3)} V`}
              </span>
            </li>
          )
        })}
      </ul>
      <p className={FOOT}>
        The supply itself reports nothing. This model has no monitoring interface, so there is no
        temperature, no load and no fan speed to show, and none of those will ever appear here. What
        the board CAN see is what arrives on each rail, which is the next best question: a supply
        beginning to fail sags before it dies.
      </p>
    </Board>
  )
}

function TheCaseBoard() {
  return (
    <Board title="The case" icon="▣" span={8}>
      {/* The full-width panel (`PART_WIDE`): the photo earns real size here
          and the specs sit beside it rather than under it. */}
      <div className={PART_WIDE}>
        <PartPhoto part={PARTS.case} />
        <div className={PART_ID}>
          <strong className={PART_NAME}>{PARTS.case.name}</strong>
          <span className={PART_DETAIL}>{PARTS.case.detail}</span>
          <div className="mt-2 w-full">
            <Facts rows={PARTS.case.specs} />
          </div>
        </div>
      </div>
      <p className={FOOT}>
        Six drive bays with two filled, and a 70 mm cooler ceiling that picked the cooler. This is
        the one part on the page that nothing in the machine can report: SMBIOS gives the board
        vendor as the chassis vendor, because a case has no firmware and no way to introduce itself.
        So this panel is written down rather than read.
      </p>
    </Board>
  )
}
