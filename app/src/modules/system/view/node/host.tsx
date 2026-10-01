import { OS_MARK, WipBoard } from '../../../../components/machine-head'
import { BarList, Board, BoardGrid, Chip, Measures, Trend } from '../../../../components/viz'
import type { NodeSystemData } from '../../../../lib/dashboard/node-system'
import { DASH, num, pct, temp } from '../../../../lib/format'
import { partMatching } from '../../../../lib/hardware/catalog'
import {
  AgentBoard,
  MachineBoard,
  NetworkBoard,
  ProvidersBoard,
  RunningBoard,
  ServicesBoard,
} from './host-boards'
import { DetailNote, EMPTY, FOOT, MONO, NOTE, NotReadable } from './shared'

/* ── Host ─────────────────────────────────────────────────────────────── */

/**
 * The box's Host tab, for a node: load with its history, what is hottest,
 * the machine itself, what is running, what should be and is not.
 *
 * Two boards differ in subject rather than shape. The box has Pressure,
 * which is a kernel accounting Windows and macOS do not publish; the node
 * has the processes that are busiest right now, which is the same
 * question — what is the load MADE of — answered the way those systems
 * can. And the box's Generations are the node's network: a machine with no
 * rollback menu still has a link that is or is not moving.
 */
export function NodeHostView({ d }: { d: NodeSystemData }) {
  const f = hostFacts(d)
  if (f === null) return null

  return (
    <BoardGrid>
      <LoadBoard f={f} />

      <BusiestBoard f={f} />

      <TemperatureBoard f={f} />

      <BatteryBoard f={f} />

      {/* The machine itself, on the tab about the machine itself — as the
          box's own page pictures its case. A machine the catalog knows (a
          Mac, by model and the finish chosen on Settings › Machines) gets its
          photograph; any other gets the OS mark where the case would be: the
          one thing about it you would recognise from across the room. */}
      <MachineBoard f={f} />

      <RunningBoard f={f} />

      <ServicesBoard f={f} />

      <NetworkBoard f={f} />

      <ProvidersBoard f={f} />

      <AgentBoard f={f} />

      <NotReadable t={f.t} />
    </BoardGrid>
  )
}

/** What every board of the tab reads, or null before the node has sent a document. */
function hostFacts(d: NodeSystemData) {
  const { node, status } = d
  const t = d.telemetry
  const providers = d.providers
  if (t === null || status === null) return null
  const mark = OS_MARK[node.os]
  const busiest = [...t.processes]
    .filter((p) => p.cpuPct !== null && p.cpuPct > 0)
    .sort((a, b) => (b.cpuPct ?? 0) - (a.cpuPct ?? 0))
    .slice(0, 6)
  const threads = t.cpu.threads ?? t.cpu.cores
  const machinePart = partMatching(
    'machine',
    t.machine.boardProduct ?? t.machine.model,
    node.policy.hardware?.finish,
  )
  return { d, node, t, status, providers, mark, busiest, threads, machinePart }
}

export type HostFacts = NonNullable<ReturnType<typeof hostFacts>>

function LoadBoard({ f }: { f: HostFacts }) {
  const { d, t, threads } = f
  return (
    <Board
      title="Load"
      icon="◔"
      span={8}
      aside={
        <span className={NOTE}>
          {threads === null ? 'threads unread' : `${num(threads)} threads`}
        </span>
      }
    >
      <Trend values={d.cpuSpark} tone="accent" height={90} empty="no history yet" />
      <Measures
        items={[
          { k: 'cpu now', v: pct(t.cpu.usagePct, 1) },
          ...(t.cpu.load !== null
            ? [
                { k: 'load 1m', v: num(t.cpu.load[0], 2) },
                { k: 'load 5m', v: num(t.cpu.load[1], 2) },
                { k: 'load 15m', v: num(t.cpu.load[2], 2) },
              ]
            : [
                { k: 'processes', v: num(t.processCount) },
                {
                  k: 'clock',
                  v: t.cpu.frequencyMhz === null ? DASH : `${num(t.cpu.frequencyMhz)} MHz`,
                },
                { k: 'package', v: temp(t.cpu.temperatureC) },
              ]),
        ]}
      />
      <p className={FOOT}>
        Six hours of processor, from this box&rsquo;s prometheus, which reads every machine&rsquo;s
        telemetry from the controller&rsquo;s <span className={MONO}>/nodes/metrics</span> every
        minute; the figure beside it is the agent&rsquo;s own fifteen-second sample.{' '}
        {t.cpu.load !== null
          ? `On ${num(threads)} threads a load of ${num(threads)} is fully committed, not overloaded.`
          : 'Windows keeps no load average, so the count of processes stands in for it.'}{' '}
        What the number cannot say is what the work IS, which is the panel to the right.
      </p>
    </Board>
  )
}

function BusiestBoard({ f }: { f: HostFacts }) {
  const { d, t, busiest } = f
  return (
    <Board title="Busiest now" icon="⌁" span={4}>
      {t.processes.length === 0 ? (
        <p className={EMPTY}>{d.full ? 'nothing busy' : 'processes are on the full document'}</p>
      ) : (
        <BarList
          items={busiest.map((p) => ({
            label: p.name,
            value: p.cpuPct ?? 0,
            display: pct(p.cpuPct, 0),
          }))}
          tone="accent"
          empty="everything idle"
        />
      )}
      <DetailNote d={d} />
      <p className={FOOT}>
        Percent of ONE core each, over the last sample, so a process can read above a hundred on a
        machine with many. The memory side of this list is on <b>Memory</b>.
      </p>
    </Board>
  )
}

function TemperatureBoard({ f }: { f: HostFacts }) {
  const { node, t } = f
  return t.temperatures.length > 0 ? (
    <Board title="Temperature" icon="◉" span={4}>
      <BarList
        items={t.temperatures.map((x) => ({
          label: x.label,
          value: x.celsius,
          display: `${x.celsius.toFixed(0)}°`,
        }))}
        tone="info"
        empty="no sensors reporting"
      />
    </Board>
  ) : (
    // Neither OS publishes a die temperature to a plain program: Windows
    // leaves it to the vendor's SDK or a kernel driver, Apple Silicon
    // keeps it in the SMC. Both are readable, neither is read yet.
    <WipBoard
      title="Temperature"
      icon="◉"
      span={4}
      waits={
        node.os === 'macos'
          ? 'Apple Silicon reports temperatures and fans through the SMC only; the agent does not read it yet.'
          : 'CPU and GPU temperatures on Windows need a kernel driver or the vendor’s SDK; the agent reads only what Windows publishes, which is none.'
      }
    >
      <BarList
        items={
          node.os === 'macos'
            ? [
                { label: 'CPU die', value: 58, display: '58°' },
                { label: 'GPU', value: 54, display: '54°' },
                { label: 'Battery', value: 33, display: '33°' },
                { label: 'Fan', value: 40, display: '1 890 rpm' },
              ]
            : [
                { label: 'CPU die', value: 62, display: '62°' },
                { label: 'GPU hotspot', value: 71, display: '71°' },
                { label: 'GPU memory', value: 66, display: '66°' },
                { label: 'Chipset', value: 48, display: '48°' },
              ]
        }
        tone="info"
      />
    </WipBoard>
  )
}

function BatteryBoard({ f }: { f: HostFacts }) {
  const { t } = f
  return (
    t.battery !== null && (
      <Board
        title="Battery"
        icon="▮"
        span={4}
        aside={
          <Chip tone={t.battery.charging === true ? 'ok' : 'muted'}>
            {t.battery.charging === true
              ? 'charging'
              : t.battery.charging === false
                ? 'on battery'
                : DASH}
          </Chip>
        }
      >
        <Measures
          items={[
            { k: 'charge', v: pct(t.battery.percent, 0) },
            { k: 'health', v: pct(t.battery.healthPct, 0) },
            {
              k: 'cycles',
              v: t.battery.cycles === null ? DASH : num(t.battery.cycles),
            },
          ]}
        />
        <p className={FOOT}>
          {t.battery.condition !== null
            ? `Apple calls its condition “${t.battery.condition}”. `
            : ''}
          Health is the capacity that remains of the design capacity; a battery is considered spent
          around eighty percent, and Apple rates this one for a thousand cycles.
        </p>
      </Board>
    )
  )
}
