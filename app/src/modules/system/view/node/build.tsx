import { PART, PART_DETAIL, PART_ID, PART_NAME, PartPhoto } from '../../../../components/part'
import { Board, BoardGrid, Facts, Measures } from '../../../../components/viz'
import type { NodeSystemData } from '../../../../lib/dashboard/node-system'
import { cpuName, DASH, num, pct, shortVendor, temp } from '../../../../lib/format'
import { partById, partMatching } from '../../../../lib/hardware/catalog'
import { CasePanel, ChosenBoard, GraphicsPanel, MemoryFacts, PowerPanel } from './build-panels'
import { FOOT, MONO, NOTE, NotReadable } from './shared'

/* ── Build ────────────────────────────────────────────────────────────── */

/**
 * The box's Build tab, for a node: the parts, as opposed to the layers.
 *
 * Two kinds of fact, as on the box. What the machine REPORTS — board,
 * processor, graphics, memory — comes from its firmware through the agent,
 * and the catalog (lib/hardware/catalog.ts) adds a photograph and a sentence
 * where it recognises the model. What nothing in a PC reports — the case,
 * the cooler, the supply — is CHOSEN on Settings › Machines, from the same
 * catalog, and drawn here with its photo and spec; unchosen, the board says
 * where to choose it rather than showing a stock picture of "a case".
 * A laptop is its own case, cooler and supply, so those boards give way to
 * the machine itself.
 */
export function NodeBuildView({ d }: { d: NodeSystemData }) {
  const f = buildFacts(d)
  if (f === null) return null
  return (
    <BoardGrid>
      <BoardPanel f={f} />

      <ProcessorPanel f={f} />

      <CoolingPanel f={f} />

      <MemoryPanel f={f} />

      <GraphicsPanel f={f} />

      <PowerPanel f={f} />

      <CasePanel f={f} />

      <NotReadable t={f.t} />
    </BoardGrid>
  )
}

/** What every board of the tab reads, or null before the node has sent a document. */
function buildFacts(d: NodeSystemData) {
  const { node, status } = d
  const t = d.telemetry
  if (t === null) return null
  const mk = t.machine
  const m = t.memory
  const first = m.modules[0]
  const soldered = m.slots === 0
  const mac = node.os === 'macos'
  const laptop = mk.form === 'laptop' || mac
  const boardPart = partMatching('board', mk.board_product ?? mk.model)
  const cpuPart = partMatching('cpu', t.cpu.model ?? status?.cpu)
  const memPart =
    partMatching('memory', first?.part_number) ?? partMatching('memory', first?.manufacturer)
  const machinePart = partMatching(
    'machine',
    mk.board_product ?? mk.model,
    node.policy.hardware?.finish,
  )
  const chosenCase = partById(node.policy.hardware?.case)
  const chosenCooler = partById(node.policy.hardware?.cooler)
  const chosenPsu = partById(node.policy.hardware?.psu)

  return {
    d,
    node,
    status,
    t,
    mk,
    m,
    first,
    soldered,
    mac,
    laptop,
    boardPart,
    cpuPart,
    memPart,
    machinePart,
    chosenCase,
    chosenCooler,
    chosenPsu,
  }
}

export type BuildFacts = NonNullable<ReturnType<typeof buildFacts>>

function BoardPanel({ f }: { f: BuildFacts }) {
  const { mk, mac, boardPart } = f
  return (
    <Board
      title={mac ? 'Logic board' : 'Motherboard'}
      icon="hash"
      span={4}
      aside={
        <span className={NOTE}>
          {mk.bios_version === null
            ? 'no firmware reading'
            : `${mac ? 'firmware' : 'BIOS'} ${mk.bios_version}`}
        </span>
      }
    >
      <div className={PART}>
        {boardPart !== null && <PartPhoto part={boardPart} />}
        <div className={PART_ID}>
          <strong className={PART_NAME}>{mk.board_product ?? mk.model ?? DASH}</strong>
          <span className={PART_DETAIL}>
            {boardPart?.detail ?? shortVendor(mk.board_manufacturer ?? mk.manufacturer)}
          </span>
        </div>
      </div>
      <Facts
        rows={[
          {
            k: mac ? 'Firmware' : 'BIOS',
            v: <span className={MONO}>{mk.bios_version ?? DASH}</span>,
          },
          { k: 'Built', v: mk.bios_date ?? DASH },
          { k: 'Vendor', v: shortVendor(mk.bios_vendor) },
          ...(mk.chip !== null ? [{ k: 'Chip', v: mk.chip }] : []),
          ...(boardPart?.specs ?? []),
        ]}
      />
      <p className={FOOT}>
        {mac
          ? 'Apple’s firmware moves with the OS, so a system update is a firmware update; the version here is what the last one left.'
          : 'Read from SMBIOS, so a BIOS update appears here on its own. What the maker has published since is on Motherboard.'}
      </p>
    </Board>
  )
}

function ProcessorPanel({ f }: { f: BuildFacts }) {
  const { status, t, mac, cpuPart } = f
  return (
    <Board
      title="Processor"
      icon="◈"
      span={4}
      aside={<span className={NOTE}>{temp(t.cpu.temperature_c)}</span>}
    >
      <div className={PART}>
        {cpuPart !== null && <PartPhoto part={cpuPart} />}
        <div className={PART_ID}>
          <strong className={PART_NAME}>{cpuName(t.cpu.model ?? status?.cpu)}</strong>
          <span className={PART_DETAIL}>
            {t.cpu.cores === null || t.cpu.threads === null
              ? 'core count unread'
              : `${num(t.cpu.cores)} cores, ${num(t.cpu.threads)} threads`}
            {t.cpu.frequency_mhz !== null && ` · ${(t.cpu.frequency_mhz / 1000).toFixed(1)} GHz`}
          </span>
        </div>
      </div>
      <Measures
        items={[
          { k: 'package', v: temp(t.cpu.temperature_c) },
          { k: 'busy', v: pct(t.cpu.usage_pct, 1) },
          {
            k: 'clock',
            v: t.cpu.frequency_mhz === null ? DASH : `${num(t.cpu.frequency_mhz)} MHz`,
          },
          { k: 'arch', v: status?.arch ?? DASH },
        ]}
      />
      <p className={FOOT}>
        {cpuPart?.detail ??
          (mac
            ? 'Performance and efficiency cores counted together; Apple states the split nowhere the agent can read.'
            : 'Cores are physical and threads are what the scheduler sees; the clock is the base frequency the firmware states.')}
      </p>
    </Board>
  )
}

function CoolingPanel({ f }: { f: BuildFacts }) {
  const { node, m, first, soldered, laptop, memPart, chosenCooler } = f
  return laptop ? (
    <Board title="Memory" icon="rows" span={4} aside={<span className={NOTE}>on the package</span>}>
      <MemoryFacts m={m} first={first} soldered={soldered} memPart={memPart} />
    </Board>
  ) : (
    <ChosenBoard
      title="Cooling"
      icon="❋"
      kind="cooler"
      part={chosenCooler}
      node={node}
      foot="Neither OS reports a fan speed without a vendor tool, so the cooler is the one board here with no reading — it is what was fitted, and the processor’s temperature beside it is how it is doing."
    />
  )
}

function MemoryPanel({ f }: { f: BuildFacts }) {
  const { m, first, soldered, laptop, memPart } = f
  return (
    !laptop && (
      <Board
        title="Memory"
        icon="rows"
        span={4}
        aside={
          <span className={NOTE}>
            {m.slots === null ? DASH : `${num(m.modules.length)} of ${num(m.slots)} slots`}
          </span>
        }
      >
        <MemoryFacts m={m} first={first} soldered={soldered} memPart={memPart} />
      </Board>
    )
  )
}
