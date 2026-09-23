import { Link } from '@tanstack/react-router'

import { agentHasClaude } from '../../lib/agent/status'
import { cn } from '../../lib/cn'
import type { NodeSystemData } from '../../lib/dashboard/node-system'
import { DASH, duration, num, pct, since, text } from '../../lib/format'
import { partMatching } from '../../lib/hardware/catalog'
import { PROVIDER_NAME, type ProviderKind } from '../../lib/providers/kinds'
import { PartPhoto } from '../part'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Trend } from '../viz'
import {
  DetailNote,
  EMPTY,
  FOOT,
  LIST,
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
  rate,
  temp,
  WipBoard,
} from './shared'
import { AgentUpdate } from './updates'

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
  const { node, status } = d
  const t = d.telemetry
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

  return (
    <BoardGrid>
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
          Six hours of processor, from this box&rsquo;s prometheus, which scrapes the agent&rsquo;s{' '}
          <span className={MONO}>/metrics</span> every minute; the figure beside it is the
          agent&rsquo;s own fifteen-second sample.{' '}
          {t.cpu.load !== null
            ? `On ${num(threads)} threads a load of ${num(threads)} is fully committed, not overloaded.`
            : 'Windows keeps no load average, so the count of processes stands in for it.'}{' '}
          What the number cannot say is what the work IS, which is the panel to the right.
        </p>
      </Board>

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

      {t.temperatures.length > 0 ? (
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
      )}

      {t.battery !== null && (
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
            Health is the capacity that remains of the design capacity; a battery is considered
            spent around eighty percent, and Apple rates this one for a thousand cycles.
            {t.battery.cycles === null && ' The cycle count arrives with agent 0.10.0.'}
          </p>
        </Board>
      )}

      {/* The machine itself, on the tab about the machine itself — as the
          box's own page pictures its case. A node has no photograph, so the
          OS mark stands where the case would: it is the one thing about the
          machine you would recognise from across the room. */}
      <Board title="The machine" icon="▣" span={4}>
        <div className={PART}>
          {machinePart !== null ? (
            <PartPhoto part={machinePart} />
          ) : (
            mark !== undefined && (
              <img
                src={mark.src}
                alt=""
                width={56}
                height={56}
                className={cn(
                  'block size-14 flex-none object-contain',
                  mark.invert && 'dark:invert',
                )}
              />
            )
          )}
          <div className={PART_ID}>
            <strong className={PART_NAME}>{t.machine.model ?? node.name}</strong>
            <span className={PART_DETAIL}>
              {[t.machine.manufacturer, t.machine.form].filter(Boolean).join(' · ') ||
                'make unread'}
              {t.machine.chip ? ` · ${t.machine.chip}` : ''}
            </span>
            <span className={PART_DETAIL}>
              {t.os.kernel === null
                ? 'kernel unread'
                : `${node.os === 'macos' ? 'Darwin' : 'NT'} ${t.os.kernel}`}
              , up {duration(status.osUptimeSecs)}.
            </span>
          </div>
        </div>
        <p className={FOOT}>
          The specification is on <b>Build</b>. Its address on the network is{' '}
          <span className={MONO}>{node.lanIp ?? DASH}</span>, hardware address{' '}
          <span className={MONO}>{text(node.mac)}</span>.
        </p>
      </Board>

      <Board title="Running" icon="▣" span={4}>
        <Facts
          rows={[
            { k: 'Uptime', v: duration(status.osUptimeSecs) },
            {
              k: 'Booted',
              v:
                status.bootedAt === null
                  ? DASH
                  : since((Date.now() - Date.parse(status.bootedAt)) / 1000),
            },
            {
              k: 'Kernel',
              v: t.os.kernel === null ? DASH : <span className={MONO}>{t.os.kernel}</span>,
            },
            { k: 'Processes', v: num(t.processCount) },
            {
              k: node.os === 'macos' ? 'Jobs failing' : 'Services down',
              v: !d.full ? (
                DASH
              ) : t.services.length > 0 ? (
                <Chip tone="bad">{num(t.services.length)}</Chip>
              ) : (
                <Chip tone="ok">none</Chip>
              ),
            },
          ]}
        />
      </Board>

      <Board
        title={
          !d.full
            ? node.os === 'macos'
              ? 'Failing jobs'
              : 'Services down'
            : t.services.length === 0
              ? node.os === 'macos'
                ? 'No failing jobs'
                : 'No services down'
              : node.os === 'macos'
                ? 'Failing jobs'
                : 'Services down'
        }
        icon="⚑"
        span={t.battery === null ? 8 : 4}
        aside={
          !d.full ? undefined : t.services.length === 0 ? (
            <Chip tone="ok">none</Chip>
          ) : (
            <Chip tone="bad">{num(t.services.length)}</Chip>
          )
        }
      >
        {!d.full ? (
          <p className={EMPTY}>On the full document.</p>
        ) : t.services.length === 0 ? (
          <p className={EMPTY}>
            {node.os === 'macos'
              ? `Nothing outside Apple's own launchd jobs exited with an error${t.serviceCount === null ? '' : `, of ${num(t.serviceCount)} loaded`}.`
              : `Every Automatic service is running or stopped cleanly${t.serviceCount === null ? '' : `, of ${num(t.serviceCount)} installed`}.`}
          </p>
        ) : (
          <ul className={LIST}>
            {t.services.map((s) => (
              <li key={s.name} className={ROW}>
                <Chip tone="bad">{s.state}</Chip>
                <span className={cn(ROW_MAIN, MONO)}>{s.name}</span>
                <span className={ROW_SIDE}>
                  {s.display ?? ''}
                  {s.exitCode !== null && ` · exit ${String(s.exitCode)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
        <DetailNote d={d} />
        <p className={FOOT}>
          {node.os === 'macos'
            ? 'launchd jobs in the system domain whose last exit was not zero, Apple’s own left out because half of them exit non-zero by design. The box’s equivalent is its failed units.'
            : 'Services set to start automatically that are stopped with an exit code other than clean or never-started — the Windows reading of the box’s failed units. A service that simply finished its work and exited zero is not listed.'}{' '}
          Read every ten minutes.
        </p>
      </Board>

      <Board
        title="Network"
        icon="⇵"
        span={4}
        aside={<span className={NOTE}>{num(t.network.length)} up</span>}
      >
        {t.network.length === 0 ? (
          <p className={EMPTY}>No interfaces up.</p>
        ) : (
          <ul className={LIST}>
            {t.network.map((n) => (
              <li key={n.interface} className={`${ROW} flex-wrap`}>
                <span className={cn(ROW_MAIN, MONO)}>{n.interface}</span>
                <span className={`${ROW_SIDE} tabular-nums`}>
                  ↓ {rate(n.rxBps)} · ↑ {rate(n.txBps)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className={FOOT}>
          Bytes per second since the previous sample, on the interfaces that are up. Since boot:{' '}
          {t.network.reduce((s, n) => s + (n.rxBytes ?? 0), 0) > 0
            ? `${num(Math.round(t.network.reduce((s, n) => s + (n.rxBytes ?? 0), 0) / 1e9))} GB in, ${num(Math.round(t.network.reduce((s, n) => s + (n.txBytes ?? 0), 0) / 1e9))} GB out`
            : DASH}
          .
        </p>
      </Board>

      <Board
        title="Providers"
        icon="◈"
        span={12}
        aside={
          t.providers.length === 0 ? (
            <span className={NOTE}>none found</span>
          ) : t.providers.every((p) => p.running) ? (
            <Chip tone="ok">{num(t.providers.length)} running</Chip>
          ) : (
            <Chip tone="warn">
              {num(t.providers.filter((p) => p.running).length)} of {num(t.providers.length)}{' '}
              running
            </Chip>
          )
        }
      >
        {t.providers.length === 0 ? (
          <p className={EMPTY}>
            {status.version !== null && agentBefore(status.version, '0.11.0')
              ? 'Providers are reported by agent 0.11.0 and later.'
              : 'No model server found on this machine.'}
          </p>
        ) : (
          <ul className={LIST}>
            {t.providers.map((p) => (
              <li key={`${p.kind}:${String(p.port)}`} className={ROW}>
                {p.running ? (
                  <Chip tone="ok">running</Chip>
                ) : (
                  <Chip tone="warn">found, not running</Chip>
                )}
                <span className={ROW_MAIN}>
                  {providerName(p.kind)}
                  {p.version !== null && (
                    <span className="ml-[0.4rem] text-muted-foreground">v{p.version}</span>
                  )}
                </span>
                <span className={cn(ROW_SIDE, MONO)}>port {String(p.port)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className={FOOT}>
          What this machine offers the network beyond itself. The agent reports that a server is
          here and answering; the box reads its catalog from the server directly, at this machine's
          name, which is the address the gateway dials.
        </p>
      </Board>

      <Board
        title="Agent"
        icon="◎"
        span={12}
        aside={
          status.restartPending ? (
            <Chip tone="ok">installed, restarting</Chip>
          ) : status.updateAvailable !== null ? (
            <Chip tone="warn">{status.updateAvailable}</Chip>
          ) : (
            <span className={MONO}>{status.version}</span>
          )
        }
      >
        <Facts
          rows={[
            { k: 'Running', v: <span className={MONO}>{status.version}</span> },
            {
              k: 'Updates',
              v: status.restartPending
                ? 'installed, restarting'
                : (status.updateAvailable ?? status.lastUpdateResult ?? 'not checked yet'),
            },
            { k: 'Box', v: `approved · last hello ${since(node.lastSeenAgo)}` },
            { k: 'Tray', v: status.trayReporting ? 'reporting' : 'not reporting' },
            {
              k: 'Claude',
              v:
                status.claude != null
                  ? `${status.claude.state}${status.claude.serverVersion !== null ? ` ${status.claude.serverVersion}` : ''} · ${String(status.claude.sessions)} session${status.claude.sessions === 1 ? '' : 's'}`
                  : agentHasClaude(status.version)
                    ? DASH
                    : 'needs agent 0.4.0',
            },
          ]}
        />
        <AgentUpdate node={node} />
        <p className={FOOT}>
          The agent&rsquo;s own state, and the one thing on this page that this box moves: releases
          are signed by its key, the agent verifies the signature and swaps its own binary within
          ten minutes, or now from the button. Every switch for this machine is on{' '}
          <Link to="/settings" search={{ tab: 'machines' }}>
            Settings › Machines
          </Link>
          , and its Claude remote control on{' '}
          <Link
            to="/c/$category"
            params={{ category: 'system' }}
            search={{ tab: 'claude', machine: node.id }}
          >
            Claude
          </Link>
          . The agent&rsquo;s log is on the machine, in its tray menu; nothing ships it here yet.
        </p>
      </Board>

      <NotReadable t={t} />
    </BoardGrid>
  )
}

/**
 * The product name for a provider kind, from the one map that defines them
 * (lib/providers/kinds.ts). The agent reports `kind` as free text, so a kind
 * this page predates reads as itself rather than as a blank — a newer agent
 * must not render an empty row here.
 */
function providerName(kind: string): string {
  return Object.hasOwn(PROVIDER_NAME, kind) ? PROVIDER_NAME[kind as ProviderKind] : kind
}

/** Whether an agent version predates the one a field arrived in. */
function agentBefore(version: string, since: string): boolean {
  const a = version.split('.').map(Number)
  const b = since.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}
