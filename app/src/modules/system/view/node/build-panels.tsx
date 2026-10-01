// A node's Build tab, its second half: graphics, power, the case, and the
// parts chosen by hand where the machine cannot say.

import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { Ago } from '../../../../components/ago'
import { OS_MARK } from '../../../../components/machine-head'
import {
  PART,
  PART_DETAIL,
  PART_ID,
  PART_NAME,
  PART_WIDE,
  PartHead,
  PartPhoto,
} from '../../../../components/part'
import { Board, Facts, Measures } from '../../../../components/viz'
import type { Telemetry } from '../../../../host/controller/generated'
import { cn } from '../../../../lib/cn'
import { bytes, DASH, num, pct, shortVendor, temp } from '../../../../lib/format'
import { type ChosenKind, type Part, partMatching } from '../../../../lib/hardware/catalog'
import type { NodeRow } from '../../../../lib/repo/nodes'
import type { BuildFacts } from './build'
import { EMPTY, FOOT, LIST, loadTone, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE, SUB } from './shared'

export function GraphicsPanel({ f }: { f: BuildFacts }) {
  const { t, soldered, mac, laptop } = f
  return t.gpus.length === 0 ? (
    <Board title="Graphics" icon="◐" span={laptop ? 6 : 4}>
      <p className={EMPTY}>
        {t.errors.find((e) => /gpu|graphics|display/i.test(e)) ?? 'No graphics adapter reported.'}
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
                  (g.vram_total_bytes === null
                    ? soldered
                      ? 'shares the unified memory'
                      : 'memory unread'
                    : `${bytes(g.vram_total_bytes)} of its own`)}
                {g.driver !== null && ` · driver ${g.driver}`}
              </span>
            </div>
          </div>
          <Measures
            items={[
              { k: 'busy', v: pct(g.usage_pct), tone: loadTone(g.usage_pct) },
              { k: 'memory', v: bytes(g.vram_used_bytes) },
              { k: 'temp', v: temp(g.temperature_c) },
              { k: 'power', v: g.power_w === null ? DASH : `${g.power_w.toFixed(1)} W` },
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
  )
}

export function PowerPanel({ f }: { f: BuildFacts }) {
  const { node, t, laptop, chosenPsu } = f
  return laptop ? (
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
              { k: 'health', v: pct(t.battery.health_pct) },
              {
                k: 'source',
                v: t.battery.charging === null ? DASH : t.battery.charging ? 'adapter' : 'battery',
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
  )
}

export function CasePanel({ f }: { f: BuildFacts }) {
  const { node, status, t, mk, laptop, machinePart, chosenCase } = f
  return laptop ? (
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
            v: `${status?.os_name ?? node.os}${status?.os_version ? ` ${status.os_version}` : ''}`,
          },
          { k: 'Kernel', v: <span className={MONO}>{t.os.kernel ?? DASH}</span> },
          ...(t.os.build ? [{ k: 'Build', v: <span className={MONO}>{t.os.build}</span> }] : []),
          { k: 'Installed', v: <Ago at={t.os.installed_at} /> },
          { k: 'Hardware address', v: <span className={MONO}>{node.mac ?? DASH}</span> },
        ]}
      />
      <p className={FOOT}>
        Model and chip from the machine&rsquo;s own inventory, which is what its About box reads. A
        laptop is its own case, cooler and supply, which is why this page has none of those to
        choose.
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
                    v: (
                      <>
                        {status?.version ?? node.agentVersion} · approved{' '}
                        {node.approvedAt === null ? DASH : <Ago at={node.approvedAt} />}
                      </>
                    ),
                  },
                ]}
              />
            </div>
          </div>
        </div>
      )}
      <p className={FOOT}>
        A case has no firmware and no way to introduce itself — SMBIOS names the board vendor as the
        chassis vendor — so this one is chosen, not read.
      </p>
    </Board>
  )
}

export function MemoryFacts({
  m,
  first,
  soldered,
  memPart,
}: {
  m: Telemetry['memory']
  first: Telemetry['memory']['modules'][number] | undefined
  soldered: boolean
  memPart: Part | null
}) {
  return (
    <>
      {memPart !== null && <PartHead part={memPart} />}
      <Facts
        rows={[
          { k: 'Installed', v: bytes(m.total_bytes) },
          { k: 'Type', v: first?.kind ?? DASH },
          { k: 'Speed', v: first?.speed_mts == null ? DASH : `${num(first.speed_mts)} MT/s` },
          { k: 'Maker', v: first?.manufacturer ?? DASH },
          { k: 'Part', v: <span className={MONO}>{first?.part_number ?? DASH}</span> },
          { k: 'Ceiling', v: soldered ? 'as bought' : bytes(m.max_capacity_bytes) },
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
export function ChosenBoard({
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
