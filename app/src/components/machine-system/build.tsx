import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import type { NodeTelemetry } from '../../lib/agent/status'
import { cn } from '../../lib/cn'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { bytes, DASH, num, pct, since } from '../../lib/format'
import { type ChosenKind, type Part, partById, partMatching } from '../../lib/hardware/catalog'
import type { NodeRow } from '../../lib/repo/nodes'
import { PART_WIDE, PartHead, PartPhoto } from '../part'
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
  const { node, status } = d
  const t = d.telemetry
  if (t === null) return null
  const mk = t.machine
  const m = t.memory
  const first = m.modules[0]
  const soldered = m.slots === 0
  const mac = node.os === 'macos'
  const laptop = mk.form === 'laptop' || mac
  const boardPart = partMatching('board', mk.boardProduct ?? mk.model)
  const cpuPart = partMatching('cpu', t.cpu.model ?? status?.cpu)
  const memPart =
    partMatching('memory', first?.partNumber) ?? partMatching('memory', first?.manufacturer)
  const machinePart = partMatching(
    'machine',
    mk.boardProduct ?? mk.model,
    node.policy.hardware?.finish,
  )
  const chosenCase = partById(node.policy.hardware?.case)
  const chosenCooler = partById(node.policy.hardware?.cooler)
  const chosenPsu = partById(node.policy.hardware?.psu)

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
          {boardPart !== null && <PartPhoto part={boardPart} />}
          <div className={PART_ID}>
            <strong className={PART_NAME}>{mk.boardProduct ?? mk.model ?? DASH}</strong>
            <span className={PART_DETAIL}>
              {boardPart?.detail ?? shortVendor(mk.boardManufacturer ?? mk.manufacturer)}
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
            ...(boardPart?.specs ?? []),
          ]}
        />
        <p className={FOOT}>
          {mac
            ? 'Apple’s firmware moves with the OS, so a system update is a firmware update; the version here is what the last one left.'
            : 'Read from SMBIOS, so a BIOS update appears here on its own. What the maker has published since is on Motherboard.'}
        </p>
      </Board>

      <Board
        title="Processor"
        icon="◈"
        span={4}
        aside={<span className={NOTE}>{temp(t.cpu.temperatureC)}</span>}
      >
        <div className={PART}>
          {cpuPart !== null && <PartPhoto part={cpuPart} />}
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
          {cpuPart?.detail ??
            (mac
              ? 'Performance and efficiency cores counted together; Apple states the split nowhere the agent can read.'
              : 'Cores are physical and threads are what the scheduler sees; the clock is the base frequency the firmware states.')}
        </p>
      </Board>

      {laptop ? (
        <Board
          title="Memory"
          icon="rows"
          span={4}
          aside={<span className={NOTE}>on the package</span>}
        >
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
      )}

      {!laptop && (
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
      )}

      {t.gpus.length === 0 ? (
        <Board title="Graphics" icon="◐" span={laptop ? 6 : 4}>
          <p className={EMPTY}>
            {t.errors.find((e) => /gpu|graphics|display/i.test(e)) ??
              'No graphics adapter reported.'}
          </p>
        </Board>
      ) : (
        t.gpus.map((g, i) => {
          const gpuPart = partMatching('gpu', g.name)
          return (
            <Board
              key={`${g.name}-${String(i)}`}
              title={t.gpus.length === 1 ? 'Graphics' : `Graphics ${String(i + 1)}`}
              icon="◐"
              span={laptop ? 6 : 4}
              aside={g.vendor !== null ? <span className={NOTE}>{g.vendor}</span> : undefined}
            >
              <div className={PART}>
                {gpuPart !== null && <PartPhoto part={gpuPart} />}
                <div className={PART_ID}>
                  <strong className={PART_NAME}>{g.name}</strong>
                  <span className={PART_DETAIL}>
                    {gpuPart?.detail ??
                      (g.vramTotalBytes === null
                        ? soldered
                          ? 'shares the unified memory'
                          : 'memory unread'
                        : `${bytes(g.vramTotalBytes)} of its own`)}
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
                  ? 'Device utilisation as the accelerator driver counts it; power and temperature come from powermetrics, which on this chip does not answer inside the agent’s deadline.'
                  : 'The 3D engine’s utilisation and the dedicated memory in use, from the same counters Task Manager draws. Temperature and power need the vendor’s own tool.'}
              </p>
            </Board>
          )
        })
      )}

      {laptop ? (
        <Board
          title="Power"
          icon="⚡"
          span={6}
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
            <p className={EMPTY}>No battery reported.</p>
          ) : (
            <>
              <Measures
                items={[
                  { k: 'charge', v: pct(t.battery.percent) },
                  { k: 'health', v: pct(t.battery.healthPct) },
                  {
                    k: 'source',
                    v:
                      t.battery.charging === null
                        ? DASH
                        : t.battery.charging
                          ? 'adapter'
                          : 'battery',
                  },
                ]}
              />
              <p className={FOOT}>
                Health is the capacity that remains against the design capacity, which is the number
                that decides when the battery is replaced.
              </p>
            </>
          )}
        </Board>
      ) : (
        <ChosenBoard
          title="Power"
          icon="⚡"
          kind="psu"
          part={chosenPsu}
          node={node}
          foot="A desktop supply reports nothing from software — no load, no temperature, no fan — which is the same gap the box has. What is here is what was fitted."
        />
      )}

      {laptop ? (
        <Board title="The machine" icon="▣" span={12}>
          <MachineWide
            part={machinePart}
            fallbackName={mk.model ?? node.name}
            detail={
              machinePart?.detail ??
              ([shortVendor(mk.manufacturer), mk.form].filter((x) => x !== DASH && x).join(' · ') ||
                'make unread')
            }
            mark={OS_MARK[node.os]}
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
            ]}
          />
          <p className={FOOT}>
            Model and chip from the machine&rsquo;s own inventory, which is what its About box
            reads. A laptop is its own case, cooler and supply, which is why this page has none of
            those to choose.
          </p>
        </Board>
      ) : (
        <Board
          title={chosenCase === null ? 'The case' : chosenCase.name}
          icon="▣"
          span={12}
          aside={chosenCase === null ? undefined : <span className={NOTE}>chosen on Settings</span>}
        >
          {chosenCase === null ? (
            <NotChosen kind="case" node={node} />
          ) : (
            <div className={PART_WIDE}>
              <PartPhoto part={chosenCase} />
              <div className={PART_ID}>
                <strong className={PART_NAME}>{chosenCase.name}</strong>
                <span className={PART_DETAIL}>{chosenCase.detail}</span>
                <div className="mt-2 w-full">
                  <Facts
                    rows={[
                      ...chosenCase.specs,
                      {
                        k: 'Machine',
                        v: `${shortVendor(mk.manufacturer)} ${mk.model ?? ''}`.trim(),
                      },
                      {
                        k: 'Hardware address',
                        v: <span className={MONO}>{node.mac ?? DASH}</span>,
                      },
                      {
                        k: 'Agent',
                        v: `${status?.version ?? node.agentVersion} · approved ${node.approvedAt === null ? DASH : since((Date.now() - Date.parse(node.approvedAt)) / 1000)}`,
                      },
                    ]}
                  />
                </div>
              </div>
            </div>
          )}
          <p className={FOOT}>
            A case has no firmware and no way to introduce itself — SMBIOS names the board vendor as
            the chassis vendor — so this one is chosen, not read.
          </p>
        </Board>
      )}

      <NotReadable t={t} />
    </BoardGrid>
  )
}

function MemoryFacts({
  m,
  first,
  soldered,
  memPart,
}: {
  m: NodeTelemetry['memory']
  first: NodeTelemetry['memory']['modules'][number] | undefined
  soldered: boolean
  memPart: Part | null
}) {
  return (
    <>
      {memPart !== null && <PartHead part={memPart} />}
      <Facts
        rows={[
          { k: 'Installed', v: bytes(m.totalBytes) },
          { k: 'Type', v: first?.kind ?? DASH },
          { k: 'Speed', v: first?.speedMts == null ? DASH : `${num(first.speedMts)} MT/s` },
          { k: 'Maker', v: first?.manufacturer ?? DASH },
          { k: 'Part', v: <span className={MONO}>{first?.partNumber ?? DASH}</span> },
          { k: 'Ceiling', v: soldered ? 'as bought' : bytes(m.maxCapacityBytes) },
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
    </>
  )
}

/** A part nothing reports: the catalog's entry when chosen, the way to choose it when not. */
function ChosenBoard({
  title,
  icon,
  kind,
  part,
  node,
  foot,
}: {
  title: string
  icon: string
  kind: ChosenKind
  part: Part | null
  node: NodeRow
  foot: string
}) {
  return (
    <Board
      title={title}
      icon={icon}
      span={4}
      aside={part === null ? undefined : <span className={NOTE}>chosen on Settings</span>}
    >
      {part === null ? (
        <NotChosen kind={kind} node={node} />
      ) : (
        <>
          <PartHead part={part} />
          <Facts rows={part.specs} />
        </>
      )}
      <p className={FOOT}>{foot}</p>
    </Board>
  )
}

function NotChosen({ kind, node }: { kind: ChosenKind; node: NodeRow }) {
  const what = kind === 'case' ? 'case' : kind === 'cooler' ? 'cooler' : 'power supply'
  return (
    <p className={EMPTY}>
      Not chosen. Nothing in the machine reports its {what}; pick it on{' '}
      <Link to="/settings" search={{ tab: 'machines' }}>
        Settings › Machines
      </Link>
      , under {node.name}.
    </p>
  )
}

/** The laptop itself, photographed when the catalog knows it, marked when not. */
function MachineWide({
  part,
  fallbackName,
  detail,
  mark,
  rows,
}: {
  part: Part | null
  fallbackName: string
  detail: string
  mark: { src: string; invert: boolean } | undefined
  rows: { k: string; v: ReactNode }[]
}) {
  return (
    <div className={PART_WIDE}>
      {part?.photo != null ? (
        <PartPhoto part={part} />
      ) : (
        mark !== undefined && (
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
        )
      )}
      <div className={PART_ID}>
        <strong className={PART_NAME}>{part?.name ?? fallbackName}</strong>
        <span className={PART_DETAIL}>{detail}</span>
        <div className="mt-2 w-full">
          <Facts rows={[...(part?.specs ?? []), ...rows]} />
        </div>
      </div>
    </div>
  )
}
