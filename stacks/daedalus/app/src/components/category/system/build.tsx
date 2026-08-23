import type { SystemData } from '../../../lib/dashboard/categories/system'
import { DASH, num, pct } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { BarList, Board, BoardGrid, Facts, Measures } from '../../viz'
import { HOST_READERS, PARTS, PartHead, PartPhoto } from './shared'

/* ── Build ────────────────────────────────────────────────────────────── */

type Build = Extract<SystemData, { tab: 'build' }>

export function BuildView({ d }: { d: Build }) {
  const hw = d.hardware
  const spinning = d.fans.filter((f) => f.rpm > 0)
  const board = hw.board

  return (
    <BoardGrid>
      <Board
        title="Motherboard"
        icon="hash"
        span={4}
        aside={
          <span className="board-note">
            {board.bios.version === null ? 'no BIOS reading' : `BIOS ${board.bios.version}`}
          </span>
        }
      >
        <div className="part">
          <div className="part-id">
            <strong className="part-name">{board.model ?? DASH}</strong>
            <span className="part-detail">
              {board.vendor === null ? 'unknown vendor' : shortVendor(board.vendor)}
              {board.version !== null && ` · board rev ${board.version}`}
            </span>
          </div>
        </div>
        <Facts
          rows={[
            { k: 'BIOS', v: <span className="mono">{board.bios.version ?? DASH}</span> },
            { k: 'Built', v: board.bios.date ?? DASH },
            {
              k: 'BIOS vendor',
              v: board.bios.vendor === null ? DASH : shortVendor(board.bios.vendor),
            },
            { k: 'Chipset temp', v: temp(d.temps.find((t) => t.label === 'PCH')?.value ?? null) },
            { k: 'VRM temp', v: temp(d.temps.find((t) => t.label === 'VRM MOS')?.value ?? null) },
          ]}
        />
        <p className="board-foot">
          Read from SMBIOS, so a BIOS update appears here on its own. It is deliberately not
          compared against anything: MSI publishes no machine-readable list of releases, and the
          only way to claim &ldquo;two behind&rdquo; would be to scrape a vendor page that will
          change shape without warning. A version panel that quietly starts lying is worse than one
          that only ever states what is installed.
        </p>
      </Board>

      <Board
        title="Processor"
        icon="◈"
        span={4}
        aside={<span className="board-note">{temp(d.cpu.tempC)}</span>}
      >
        <div className="part">
          <div className="part-id">
            <strong className="part-name">{cpuName(hw.cpu.model)}</strong>
            <span className="part-detail">
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
        <p className="board-foot">
          Ten cores and sixteen threads is not an error: six of them are efficiency cores with no
          hyperthread. That asymmetry is why the per-core temperature list on Host is uneven. The
          two kinds of core do not run at the same clock and are not meant to.
        </p>
      </Board>

      <Board
        title="Cooling"
        icon="❋"
        span={4}
        aside={
          <span className="board-note">
            {spinning.length === 0
              ? 'nothing spinning'
              : `${num(spinning.length)} of ${num(d.fans.length)} headers`}
          </span>
        }
      >
        <div className="part">
          <div className="part-id">
            <strong className="part-name">Noctua NH-L9x65</strong>
            <span className="part-detail">
              65 mm tall, chosen against the case&rsquo;s 70 mm ceiling. The whole build turns on
              that number.
            </span>
          </div>
        </div>
        <h4 className="board-sub">Fan headers</h4>
        <ul className="itemlist">
          {d.fans.map((f) => (
            <li key={f.label}>
              <span className="item-main">{f.label}</span>
              <span className="item-side">
                {f.rpm > 0 ? (
                  <span className="mono">{num(f.rpm)} rpm</span>
                ) : (
                  <span className="text-dim">not connected</span>
                )}
              </span>
            </li>
          ))}
          {d.fans.length === 0 && <p className="viz-empty">no fan sensors; see the note below</p>}
        </ul>
        <h4 className="board-sub">Board temperatures</h4>
        <BarList
          items={d.temps.map((t) => ({
            label: t.label,
            value: t.value,
            display: `${t.value.toFixed(0)}°`,
          }))}
          tone="info"
          empty="no board sensors"
        />
        <p className="board-foot">
          These readings exist because a driver was added for the board&rsquo;s Nuvoton super-I/O
          chip; without it Linux sees three sensors and counts no revolutions at all, which on a
          machine that lives in a cupboard makes a dead fan silent until it is thermal. Headers
          reading zero are empty, not faulty.
        </p>
      </Board>

      <Board
        title="Memory"
        icon="rows"
        span={4}
        aside={
          <span className="board-note">
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
              v: <span className="mono">{hw.memory.modules[0]?.partNumber ?? DASH}</span>,
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
        <h4 className="board-sub">Slots</h4>
        <ul className="itemlist">
          {hw.memory.modules.map((m) => (
            <li key={m.locator ?? '?'}>
              <span className="item-main">{(m.locator ?? '?').replace('Controller', 'Ch ')}</span>
              <span className="item-side">{m.sizeGb === null ? DASH : `${num(m.sizeGb)} GB`}</span>
              <span className="item-side">{m.rank === null ? DASH : `${num(m.rank)}R`}</span>
            </li>
          ))}
          {hw.memory.modules.length === 0 && <p className="viz-empty">no modules read</p>}
        </ul>
        <p className="board-foot">
          Both modules sit in the second slot of each channel, which is the pairing the board wants
          for dual channel. The empty slots are the two that would break it if filled wrong. Two
          free slots and a 128 GB ceiling is the upgrade this machine has left.
        </p>
      </Board>

      <Board
        title="Graphics"
        icon="◐"
        span={4}
        aside={
          <span className="board-note">
            {d.gpu.clients === null ? DASH : `${num(d.gpu.clients)} clients`}
          </span>
        }
      >
        <div className="part">
          <div className="part-id">
            <strong className="part-name">Intel UHD Graphics 770</strong>
            <span className="part-detail">
              Integrated in the CPU; there is no card in this machine. It transcodes for Jellyfin
              and runs Immich&rsquo;s vision models.
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
        <p className="board-foot">
          A parked graphics engine reads zero watts and zero megahertz. That is the honest number
          rather than a broken one: it wakes when something asks it to. The package figure beside it
          is the whole chip including the cpu cores, which is why the two are shown together — on an
          integrated part they are one piece of silicon and one power budget. The render node is
          passed into three containers at once: jellyfin for QSV transcoding, immich for OpenVINO,
          and the exporter these numbers come from.
        </p>
      </Board>

      <Board title="Power" icon="⚡" span={4} aside={<span className="board-note">650 W</span>}>
        <div className="part">
          <div className="part-id">
            <strong className="part-name">EVGA SuperNOVA 650 GM</strong>
            <span className="part-detail">
              SFX, 80+ Gold, fully modular. The case dictates the form factor.
            </span>
          </div>
        </div>
        <h4 className="board-sub">Rails, as the board sees them</h4>
        <ul className="itemlist">
          {['+12V', '+5V', '+3.3V'].map((rail) => {
            const v = d.volts.find((x) => x.label === rail)
            return (
              <li key={rail}>
                <span className="item-main">{rail}</span>
                <span className="item-side mono">
                  {v === undefined ? DASH : `${v.value.toFixed(3)} V`}
                </span>
              </li>
            )
          })}
        </ul>
        <p className="board-foot">
          The supply itself reports nothing. This model has no monitoring interface, so there is no
          temperature, no load and no fan speed to show, and none of those will ever appear here.
          What the board CAN see is what arrives on each rail, which is the next best question: a
          supply beginning to fail sags before it dies.
        </p>
      </Board>

      <Board title="The case" icon="▣" span={12}>
        <div className="part part-wide">
          <PartPhoto part={PARTS.case} />
          <div className="part-id">
            <strong className="part-name">{PARTS.case.name}</strong>
            <span className="part-detail">{PARTS.case.detail}</span>
            <Facts rows={PARTS.case.specs} />
          </div>
        </div>
        <p className="board-foot">
          Six drive bays with two filled, and a 70 mm cooler ceiling that picked the cooler. This is
          the one part on the page that nothing in the machine can report: SMBIOS gives the board
          vendor as the chassis vendor, because a case has no firmware and no way to introduce
          itself. So this panel is written down rather than read.
        </p>
      </Board>

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

/** "Micro-Star International Co., Ltd." is a legal name, not a brand. */
function shortVendor(v: string): string {
  return v
    .replace(/Micro-Star International Co\., Ltd\.?/i, 'MSI')
    .replace(/American Megatrends International, LLC\.?/i, 'AMI')
    .replace(/, (Inc|LLC|Ltd)\.?$/i, '')
}

/** SMBIOS spells it "12th Gen Intel(R) Core(TM) i5-12600K". Nobody says that. */
function cpuName(v: string | null): string {
  return v === null
    ? DASH
    : v
        .replace(/\((R|TM)\)/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

function temp(c: number | null): string {
  return c === null ? DASH : `${c.toFixed(0)}°`
}
