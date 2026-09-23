import { Link } from '@tanstack/react-router'

import { agentHasClaude } from '../lib/agent/status'
import { cn } from '../lib/cn'
import type { NodeSystemData } from '../lib/dashboard/node-system'
import { bytes, DASH, duration, num, pct, since, text } from '../lib/format'
import type { Tone } from '../lib/tone'
import { EMPTY, FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE } from './tokens'
import { Board, BoardGrid, Chip, Facts, Progress, Ring, Stat, StatStrip } from './viz'

// The System page, for a machine that is not this box.
//
// The box's own System page is nine tabs over prometheus, ZFS and the host
// snapshot. A node has one source — the agent's status page, sampled every
// fifteen seconds (agent/src/telemetry.rs) — and the questions are the
// ones you would ask standing in front of the machine: what is it, what
// firmware, what is it running, how hard is it working, how full are its
// disks, how hot is it. One grid, the same boards on every machine, and a
// board that says plainly what this OS would not let the agent read,
// because a dash without a reason reads as a bug.

const OS_MARK: Record<string, { src: string; invert: boolean }> = {
  windows: { src: '/icon-windows.svg', invert: false },
  macos: { src: '/icon-apple.svg', invert: true },
  linux: { src: '/icon-linux.svg', invert: true },
}

/** A percentage's tone: the same thresholds the box's own pages use. */
function loadTone(p: number | null): Tone {
  if (p === null) return 'muted'
  if (p >= 90) return 'bad'
  if (p >= 75) return 'warn'
  return 'accent'
}

function share(used: number | null, total: number | null): number | null {
  return used === null || total === null || total === 0 ? null : (used / total) * 100
}

/** "12.5 GB of 32 GB" */
function ofTotal(used: number | null, total: number | null): string {
  if (used === null && total === null) return DASH
  return `${used === null ? DASH : bytes(used)} of ${total === null ? DASH : bytes(total)}`
}

function rate(bps: number | null): string {
  if (bps === null) return DASH
  return `${bytes(bps)}/s`
}

export function MachineSystemView({ d }: { d: NodeSystemData }) {
  const { node, status } = d
  const t = d.telemetry
  const mark = OS_MARK[node.os]
  const edition = status?.osName || node.os
  const awake =
    status === null
      ? { chip: 'not answering', tone: 'muted' as Tone }
      : status.awakeHold
        ? { chip: 'held awake', tone: 'ok' as Tone }
        : status.policy.awakeHold
          ? { chip: 'hold OFF', tone: 'bad' as Tone }
          : { chip: 'may sleep', tone: 'muted' as Tone }

  const mainDisk = t?.disks[0] ?? null
  // The card that matters: the one with the most memory, which on a machine
  // with an integrated and a discrete GPU is the discrete one.
  const gpu =
    t === null || t.gpus.length === 0
      ? null
      : t.gpus.reduce((best, g) =>
          (g.vramTotalBytes ?? 0) > (best.vramTotalBytes ?? 0) ? g : best,
        )

  return (
    <>
      <div className="mb-[1.1rem] flex items-start gap-[0.85rem] max-[44rem]:flex-wrap">
        {mark !== undefined && (
          <img
            src={mark.src}
            alt=""
            width={44}
            height={44}
            className={cn('block size-11 flex-none object-contain', mark.invert && 'dark:invert')}
          />
        )}
        <div className="min-w-0 flex-auto">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="m-0 text-[1.25rem] tracking-[-0.01em]">{node.name}</h2>
            <Chip tone={awake.tone}>{awake.chip}</Chip>
          </div>
          <p className={`${NOTE} mt-1`}>
            {edition}
            {status?.osVersion ? ` · ${status.osVersion}` : ''}
            {status?.arch ? ` · ${status.arch}` : ''}
            {t?.machine.model ? ` · ${t.machine.model}` : ''}
            {' · '}
            <span className={MONO}>{node.hostname}</span>
          </p>
        </div>
      </div>

      {status === null ? (
        <p className={EMPTY}>
          The agent on {node.hostname} did not answer{d.error !== null && `: ${d.error}`}. The
          machine is asleep, off, or on a network this box cannot reach; the last hello was{' '}
          {since(node.lastSeenAgo)}.
        </p>
      ) : t === null ? (
        <p className={EMPTY}>
          The agent on {node.hostname} is {status.version}, which reports nothing about the machine
          beyond its name. Telemetry arrived in agent 0.7.0; the agent installs it on its own within
          ten minutes of a release, or now from Settings › Machines.
        </p>
      ) : null}

      <StatStrip>
        <Stat
          label="Processor"
          value={t?.cpu.usagePct == null ? DASH : pct(t.cpu.usagePct)}
          tone={t?.cpu.usagePct == null ? undefined : loadTone(t.cpu.usagePct)}
          sub={
            t?.cpu.threads != null
              ? `${num(t.cpu.threads)} threads`
              : t?.cpu.cores != null
                ? `${num(t.cpu.cores)} cores`
                : 'busy, last 15 s'
          }
        />
        <Stat
          label="Memory"
          value={t?.memory.usedBytes == null ? DASH : bytes(t.memory.usedBytes)}
          tone={loadTone(share(t?.memory.usedBytes ?? null, t?.memory.totalBytes ?? null))}
          sub={t?.memory.totalBytes == null ? 'in use' : `of ${bytes(t.memory.totalBytes)}`}
        />
        <Stat
          label={mainDisk === null ? 'Disk' : `Disk ${mainDisk.mount}`}
          value={
            mainDisk === null || mainDisk.usedBytes === null ? DASH : bytes(mainDisk.usedBytes)
          }
          tone={loadTone(share(mainDisk?.usedBytes ?? null, mainDisk?.totalBytes ?? null))}
          sub={mainDisk?.totalBytes == null ? 'in use' : `of ${bytes(mainDisk.totalBytes)}`}
        />
        <Stat
          label={gpu === null ? 'GPU' : 'GPU'}
          value={
            gpu === null
              ? DASH
              : gpu.usagePct !== null
                ? pct(gpu.usagePct)
                : gpu.vramUsedBytes !== null
                  ? bytes(gpu.vramUsedBytes)
                  : DASH
          }
          tone={gpu === null ? undefined : loadTone(gpu.usagePct)}
          sub={gpu === null ? 'none reported' : gpu.usagePct !== null ? 'busy' : 'memory in use'}
        />
      </StatStrip>

      <BoardGrid>
        <Board title="Machine" span={6}>
          <Facts
            list
            rows={[
              { k: 'Make', v: text(t?.machine.manufacturer) },
              { k: 'Model', v: text(t?.machine.model) },
              ...(t?.machine.chip ? [{ k: 'Chip', v: text(t.machine.chip) }] : []),
              {
                k: 'Board',
                v:
                  t?.machine.boardProduct == null && t?.machine.boardManufacturer == null
                    ? DASH
                    : `${t?.machine.boardManufacturer ?? ''} ${t?.machine.boardProduct ?? ''}`.trim(),
              },
              {
                k: 'Firmware',
                v: (
                  <span>
                    <span className={MONO}>{text(t?.machine.biosVersion)}</span>
                    {t?.machine.biosVendor && (
                      <span className="text-(--text-muted)"> · {t.machine.biosVendor}</span>
                    )}
                    {t?.machine.biosDate && (
                      <span className="text-(--text-muted)"> · {t.machine.biosDate}</span>
                    )}
                  </span>
                ),
              },
              { k: 'Hardware address', v: <span className={MONO}>{text(node.mac)}</span> },
              {
                k: 'Address',
                v:
                  node.lanIp === null ? (
                    DASH
                  ) : (
                    <a
                      href={`http://${node.lanIp}:${String(node.statusPort ?? 7787)}/status`}
                      target="_blank"
                      rel="noreferrer"
                      className={MONO}
                    >
                      {node.lanIp}
                    </a>
                  ),
              },
            ]}
          />
        </Board>

        <Board title="Operating system" span={6}>
          <Facts
            list
            rows={[
              { k: 'System', v: edition },
              { k: 'Version', v: text(status?.osVersion) },
              { k: 'Kernel', v: <span className={MONO}>{text(t?.os.kernel)}</span> },
              ...(t?.os.build
                ? [{ k: 'Build', v: <span className={MONO}>{t.os.build}</span> }]
                : []),
              { k: 'Architecture', v: <span className={MONO}>{text(status?.arch)}</span> },
              {
                k: 'Installed',
                v:
                  t?.os.installedAt == null
                    ? DASH
                    : `${since((Date.now() - Date.parse(t.os.installedAt)) / 1000)}`,
              },
              {
                k: 'Up',
                v:
                  status?.osUptimeSecs == null
                    ? DASH
                    : `${duration(status.osUptimeSecs)}${status.bootedAt !== null ? ` · booted ${since((Date.now() - Date.parse(status.bootedAt)) / 1000)}` : ''}`,
              },
            ]}
          />
        </Board>

        <Board title="Processor" span={6}>
          <div className="flex flex-wrap items-center gap-6">
            <Ring
              pct={t?.cpu.usagePct ?? null}
              value={t?.cpu.usagePct == null ? DASH : pct(t.cpu.usagePct)}
              label="busy"
              tone={loadTone(t?.cpu.usagePct ?? null)}
            />
            <div className="min-w-0 flex-auto">
              <Facts
                list
                rows={[
                  { k: 'Model', v: text(t?.cpu.model ?? status?.cpu) },
                  {
                    k: 'Cores',
                    v:
                      t?.cpu.cores == null && t?.cpu.threads == null
                        ? DASH
                        : `${t?.cpu.cores == null ? DASH : num(t.cpu.cores)} cores · ${t?.cpu.threads == null ? DASH : num(t.cpu.threads)} threads`,
                  },
                  {
                    k: 'Frequency',
                    v: t?.cpu.frequencyMhz == null ? DASH : `${num(t.cpu.frequencyMhz)} MHz`,
                  },
                  ...(t?.cpu.load
                    ? [
                        {
                          k: 'Load',
                          v: (
                            <span className={MONO}>
                              {t.cpu.load.map((l) => l.toFixed(2)).join(' · ')}
                            </span>
                          ),
                        },
                      ]
                    : []),
                  ...(t?.cpu.temperatureC != null
                    ? [{ k: 'Temperature', v: `${t.cpu.temperatureC.toFixed(0)} °C` }]
                    : []),
                ]}
              />
            </div>
          </div>
        </Board>

        <Board title="Memory" span={6}>
          <Facts
            list
            rows={[
              {
                k: 'In use',
                v: (
                  <span className="flex flex-col gap-1">
                    <span>
                      {ofTotal(t?.memory.usedBytes ?? null, t?.memory.totalBytes ?? null)}
                    </span>
                    <Progress
                      pct={share(t?.memory.usedBytes ?? null, t?.memory.totalBytes ?? null)}
                      tone={loadTone(
                        share(t?.memory.usedBytes ?? null, t?.memory.totalBytes ?? null),
                      )}
                    />
                  </span>
                ),
              },
              {
                k: 'Available',
                v: t?.memory.availableBytes == null ? DASH : bytes(t.memory.availableBytes),
              },
              {
                k: 'Swap',
                v:
                  t?.memory.swapTotalBytes == null
                    ? DASH
                    : ofTotal(t.memory.swapUsedBytes, t.memory.swapTotalBytes),
              },
            ]}
          />
        </Board>

        <Board
          title="Disks"
          span={12}
          aside={t !== null && <span className={NOTE}>{num(t.disks.length)} volumes</span>}
        >
          {t === null || t.disks.length === 0 ? (
            <p className={EMPTY}>No disks reported.</p>
          ) : (
            <ul className={LIST}>
              {t.disks.map((disk) => {
                const p = share(disk.usedBytes, disk.totalBytes)
                return (
                  <li key={disk.mount} className={`${ROW} flex-wrap`}>
                    <div className={`${ROW_MAIN} flex items-baseline gap-2`}>
                      <span className={`${MONO} font-medium`}>{disk.mount}</span>
                      <span className={NOTE}>
                        {[disk.name, disk.fs, disk.kind].filter(Boolean).join(' · ')}
                      </span>
                    </div>
                    <div className={`${ROW_SIDE} flex items-center gap-3`}>
                      <span className="w-24 flex-none">
                        <Progress pct={p} tone={loadTone(p)} />
                      </span>
                      <span className="tabular-nums">
                        {ofTotal(disk.usedBytes, disk.totalBytes)}
                        {p !== null && ` · ${pct(p)}`}
                      </span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Board>

        {t !== null && t.gpus.length > 0
          ? t.gpus.map((g, i) => (
              <Board
                key={`${g.name}-${String(i)}`}
                title={t.gpus.length === 1 ? 'GPU' : `GPU ${String(i + 1)}`}
                span={6}
                aside={g.vendor !== null && <span className={NOTE}>{g.vendor}</span>}
              >
                <Facts
                  list
                  rows={[
                    { k: 'Model', v: g.name },
                    { k: 'Driver', v: <span className={MONO}>{text(g.driver)}</span> },
                    {
                      k: 'Busy',
                      v: (
                        <span className="flex flex-col gap-1">
                          <span>{g.usagePct === null ? DASH : pct(g.usagePct)}</span>
                          <Progress pct={g.usagePct} tone={loadTone(g.usagePct)} />
                        </span>
                      ),
                    },
                    { k: 'Memory', v: ofTotal(g.vramUsedBytes, g.vramTotalBytes) },
                    ...(g.temperatureC !== null
                      ? [{ k: 'Temperature', v: `${g.temperatureC.toFixed(0)} °C` }]
                      : []),
                    ...(g.powerW !== null ? [{ k: 'Power', v: `${g.powerW.toFixed(1)} W` }] : []),
                  ]}
                />
              </Board>
            ))
          : null}

        <Board title="Network" span={6}>
          {t === null || t.network.length === 0 ? (
            <p className={EMPTY}>No interfaces reported.</p>
          ) : (
            <ul className={LIST}>
              {t.network.map((n) => (
                <li key={n.interface} className={ROW}>
                  <div className={ROW_MAIN}>
                    <span className={`${MONO} font-medium`}>{n.interface}</span>
                  </div>
                  <div className={`${ROW_SIDE} flex items-center gap-3 tabular-nums`}>
                    <span>↓ {rate(n.rxBps)}</span>
                    <span>↑ {rate(n.txBps)}</span>
                    <span className={NOTE}>
                      {n.rxBytes === null ? DASH : bytes(n.rxBytes)} in ·{' '}
                      {n.txBytes === null ? DASH : bytes(n.txBytes)} out since boot
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Board>

        <Board title="Temperatures" span={6}>
          {t === null || t.temperatures.length === 0 ? (
            <p className={EMPTY}>
              {t?.errors.find((e) => /^temperatures/i.test(e)) ??
                t?.errors.find((e) => /temperature/i.test(e)) ??
                'No sensors reported.'}
            </p>
          ) : (
            <Facts
              list
              rows={t.temperatures.map((x) => ({ k: x.label, v: `${x.celsius.toFixed(0)} °C` }))}
            />
          )}
          {t?.battery && (
            <div className="mt-3">
              <Facts
                list
                rows={[
                  {
                    k: 'Battery',
                    v: `${t.battery.percent === null ? DASH : pct(t.battery.percent)}${t.battery.charging === null ? '' : t.battery.charging ? ' · charging' : ' · on battery'}`,
                  },
                  ...(t.battery.healthPct !== null
                    ? [{ k: 'Battery health', v: pct(t.battery.healthPct) }]
                    : []),
                ]}
              />
            </div>
          )}
        </Board>

        <Board title="Agent" span={6}>
          <Facts
            list
            rows={[
              {
                k: 'Version',
                v: <span className={MONO}>{status?.version ?? node.agentVersion}</span>,
              },
              {
                k: 'Updates',
                v:
                  status === null
                    ? DASH
                    : status.restartPending
                      ? 'installed, restarting'
                      : (status.updateAvailable ?? status.lastUpdateResult ?? 'not checked yet'),
              },
              { k: 'Box', v: `approved · last hello ${since(node.lastSeenAgo)}` },
              {
                k: 'Tray',
                v: status === null ? DASH : status.trayReporting ? 'reporting' : 'not reporting',
              },
              {
                k: 'Claude',
                v:
                  status?.claude != null
                    ? `${status.claude.state}${status.claude.serverVersion !== null ? ` ${status.claude.serverVersion}` : ''} · ${String(status.claude.sessions)} session${status.claude.sessions === 1 ? '' : 's'}`
                    : status !== null && !agentHasClaude(status.version)
                      ? 'needs agent 0.4.0'
                      : DASH,
              },
              {
                k: 'Sampled',
                v: t === null ? DASH : since((Date.now() - Date.parse(t.sampledAt)) / 1000),
              },
            ]}
          />
          <p className={FOOT}>
            The agent's own state and every switch for this machine are on{' '}
            <Link to="/settings" search={{ tab: 'machines' }}>
              Settings › Machines
            </Link>
            ; its Claude remote control is on{' '}
            <Link to="/claude" search={{ machine: node.id }}>
              Claude
            </Link>
            .
          </p>
        </Board>

        {t !== null && t.errors.length > 0 && (
          <Board title="Not readable here" span={12}>
            <ul className={LIST}>
              {t.errors.map((e) => (
                <li key={e} className={ROW}>
                  <span className={ROW_MAIN}>{e}</span>
                </li>
              ))}
            </ul>
            <p className={FOOT}>
              What this operating system would not let the agent read without vendor tools. Each
              line is a dash somewhere above, explained.
            </p>
          </Board>
        )}
      </BoardGrid>
    </>
  )
}
